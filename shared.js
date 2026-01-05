// Shared helpers for img.html and vid.html.
function readUint32(view, offset) {
    return view.getUint32(offset, false);
}

function readInt32(view, offset) {
    return view.getInt32(offset, false);
}

function readUint64(view, offset) {
    const high = view.getUint32(offset, false);
    const low = view.getUint32(offset + 4, false);
    return (BigInt(high) << 32n) | BigInt(low);
}

function readString(view, offset, length) {
    let out = '';
    for (let i = 0; i < length; i++) {
        out += String.fromCharCode(view.getUint8(offset + i));
    }
    return out;
}

function readVint(view, offset, maskLengthBit) {
    const first = view.getUint8(offset);
    let length = 1;
    if (first & 0x80) length = 1;
    else if (first & 0x40) length = 2;
    else if (first & 0x20) length = 3;
    else if (first & 0x10) length = 4;
    else if (first & 0x08) length = 5;
    else if (first & 0x04) length = 6;
    else if (first & 0x02) length = 7;
    else length = 8;

    let value = 0;
    if (maskLengthBit) {
        const mask = 1 << (8 - length);
        value = first & (mask - 1);
        for (let i = 1; i < length; i++) {
            value = (value << 8) | view.getUint8(offset + i);
        }
        if (value === (mask - 1)) {
            return { value: -1, length };
        }
    } else {
        for (let i = 0; i < length; i++) {
            value = (value << 8) | view.getUint8(offset + i);
        }
    }
    return { value, length };
}

function readEbmlUnsigned(view, start, end) {
    let value = 0;
    for (let i = start; i < end; i++) {
        value = (value << 8) | view.getUint8(i);
    }
    return value;
}

function estimateBitrate(fileSizeBytes, durationSeconds) {
    if (!durationSeconds || !fileSizeBytes) return null;
    return Math.round((fileSizeBytes * 8) / durationSeconds);
}

function formatBitrateMbps(bitrateBps, decimals = 1) {
    if (!bitrateBps || !Number.isFinite(bitrateBps)) return '';
    return `${(bitrateBps / 1000000).toFixed(decimals)} Mbps`;
}

function estimateFps(demuxed) {
    if (!demuxed) return null;
    if (demuxed.nativeFps && Number.isFinite(demuxed.nativeFps)) {
        return demuxed.nativeFps;
    }
    if (demuxed.samples && demuxed.samples.length && demuxed.duration) {
        return demuxed.samples.length / demuxed.duration;
    }
    return null;
}

function parseMp4(buffer) {
    const view = new DataView(buffer);
    const topLevel = [];
    let offset = 0;
    while (offset + 8 <= view.byteLength) {
        let size = readUint32(view, offset);
        const type = readString(view, offset + 4, 4);
        let headerSize = 8;
        if (size === 1) {
            size = Number(readUint64(view, offset + 8));
            headerSize = 16;
        } else if (size === 0) {
            size = view.byteLength - offset;
        }
        topLevel.push({ type, start: offset, size, headerSize });
        offset += size;
    }

    function findChildren(box, types) {
        const out = [];
        let ptr = box.start + box.headerSize;
        const end = box.start + box.size;
        while (ptr + 8 <= end) {
            let size = readUint32(view, ptr);
            const type = readString(view, ptr + 4, 4);
            let headerSize = 8;
            if (size === 1) {
                size = Number(readUint64(view, ptr + 8));
                headerSize = 16;
            } else if (size === 0) {
                size = end - ptr;
            }
            if (!types || types.includes(type)) {
                out.push({ type, start: ptr, size, headerSize });
            }
            ptr += size;
        }
        return out;
    }

    const moov = topLevel.find(b => b.type === 'moov');
    const mdat = topLevel.find(b => b.type === 'mdat');
    if (!moov || !mdat) {
        throw new Error('MP4 missing moov/mdat');
    }

    const trak = findChildren(moov, ['trak']).find(t => {
        const mdia = findChildren(t, ['mdia'])[0];
        if (!mdia) return false;
        const hdlr = findChildren(mdia, ['hdlr'])[0];
        if (!hdlr) return false;
        const handlerType = readString(view, hdlr.start + hdlr.headerSize + 8, 4);
        return handlerType === 'vide';
    });
    if (!trak) throw new Error('MP4 video track not found');

    const mdia = findChildren(trak, ['mdia'])[0];
    const mdhd = findChildren(mdia, ['mdhd'])[0];
    let timescale = 0;
    let duration = 0;
    const version = view.getUint8(mdhd.start + mdhd.headerSize);
    if (version === 1) {
        timescale = readUint32(view, mdhd.start + mdhd.headerSize + 20);
        duration = Number(readUint64(view, mdhd.start + mdhd.headerSize + 24));
    } else {
        timescale = readUint32(view, mdhd.start + mdhd.headerSize + 12);
        duration = readUint32(view, mdhd.start + mdhd.headerSize + 16);
    }

    const minf = findChildren(mdia, ['minf'])[0];
    const stbl = findChildren(minf, ['stbl'])[0];
    const stsd = findChildren(stbl, ['stsd'])[0];
    const stts = findChildren(stbl, ['stts'])[0];
    const stsz = findChildren(stbl, ['stsz'])[0];
    const stsc = findChildren(stbl, ['stsc'])[0];
    const stco = findChildren(stbl, ['stco', 'co64'])[0];
    const stss = findChildren(stbl, ['stss'])[0];
    const ctts = findChildren(stbl, ['ctts'])[0];

    const entryCount = readUint32(view, stsd.start + stsd.headerSize + 4);
    if (!entryCount) {
        throw new Error('MP4 stsd missing entry');
    }
    const sampleEntryStart = stsd.start + stsd.headerSize + 8;
    const sampleEntrySize = readUint32(view, sampleEntryStart);
    const codecType = readString(view, sampleEntryStart + 4, 4);
    let avcC = null;
    let width = view.getUint16(sampleEntryStart + 24, false);
    let height = view.getUint16(sampleEntryStart + 26, false);
    let entryPtr = sampleEntryStart + 8 + 78;
    const entryEnd = sampleEntryStart + sampleEntrySize;
    while (entryPtr + 8 <= entryEnd) {
        const boxSize = readUint32(view, entryPtr);
        const boxType = readString(view, entryPtr + 4, 4);
        if (boxSize < 8) {
            break;
        }
        if (boxType === 'avcC' || boxType === 'hvcC') {
            avcC = new Uint8Array(buffer.slice(entryPtr + 8, entryPtr + boxSize));
            break;
        }
        entryPtr += boxSize;
    }

    // Allow HEVC (hvc1/hev1) and other codecs for playback method
    // Only H.264 with avcC is fully supported for WebCodecs
    if (codecType === 'avc1' && !avcC) {
        console.warn('⚠️ avcC box missing for H.264, playback method may work');
    } else if (!['avc1', 'hvc1', 'hev1'].includes(codecType)) {
        console.warn(`⚠️ Uncommon codec: ${codecType}, playback method may work`);
    }

    const sttsCount = readUint32(view, stts.start + stts.headerSize + 4);
    let sttsPtr = stts.start + stts.headerSize + 8;
    const sampleDeltas = [];
        for (let i = 0; i < sttsCount; i++) {
            const count = readUint32(view, sttsPtr);
            const delta = readUint32(view, sttsPtr + 4);
            for (let j = 0; j < count; j++) sampleDeltas.push(delta);
            sttsPtr += 8;
        }

    const sampleSize = readUint32(view, stsz.start + stsz.headerSize + 4);
    const sampleCount = readUint32(view, stsz.start + stsz.headerSize + 8);
    const sampleSizes = [];
    if (sampleSize) {
        for (let i = 0; i < sampleCount; i++) {
            sampleSizes.push(sampleSize);
        }
    } else {
        let stszPtr = stsz.start + stsz.headerSize + 12;
        for (let i = 0; i < sampleCount; i++) {
            sampleSizes.push(readUint32(view, stszPtr));
            stszPtr += 4;
        }
    }

    const stscCount = readUint32(view, stsc.start + stsc.headerSize + 4);
    const stscEntries = [];
    let stscPtr = stsc.start + stsc.headerSize + 8;
    for (let i = 0; i < stscCount; i++) {
        const firstChunk = readUint32(view, stscPtr);
        const samplesPerChunk = readUint32(view, stscPtr + 4);
        stscEntries.push({ firstChunk, samplesPerChunk });
        stscPtr += 12;
    }

    const chunkCount = readUint32(view, stco.start + stco.headerSize + 4);
    const chunkOffsets = [];
    let stcoPtr = stco.start + stco.headerSize + 8;
    if (stco.type === 'co64') {
        for (let i = 0; i < chunkCount; i++) {
            const off = Number(readUint64(view, stcoPtr));
            chunkOffsets.push(off);
            stcoPtr += 8;
        }
    } else {
        for (let i = 0; i < chunkCount; i++) {
            chunkOffsets.push(readUint32(view, stcoPtr));
            stcoPtr += 4;
        }
    }

    let syncSamples = null;
    if (stss) {
        const syncCount = readUint32(view, stss.start + stss.headerSize + 4);
        syncSamples = new Set();
        let stssPtr = stss.start + stss.headerSize + 8;
        for (let i = 0; i < syncCount; i++) {
            syncSamples.add(readUint32(view, stssPtr));
            stssPtr += 4;
        }
    }

    let compositionOffsets = null;
    if (ctts) {
        const version = view.getUint8(ctts.start + ctts.headerSize);
        const entryCount = readUint32(view, ctts.start + ctts.headerSize + 4);
        compositionOffsets = [];
        let cttsPtr = ctts.start + ctts.headerSize + 8;
        for (let i = 0; i < entryCount; i++) {
            const count = readUint32(view, cttsPtr);
            const offset = version === 1 ? readInt32(view, cttsPtr + 4) : readUint32(view, cttsPtr + 4);
            for (let j = 0; j < count; j++) {
                compositionOffsets.push(offset);
            }
            cttsPtr += 8;
        }
    }

    const samples = [];
    let dts = 0;
    let sampleIndex = 0;
    for (let chunkIndex = 1; chunkIndex <= chunkOffsets.length; chunkIndex++) {
        let samplesPerChunk = stscEntries[stscEntries.length - 1].samplesPerChunk;
        for (let i = 0; i < stscEntries.length; i++) {
            const entry = stscEntries[i];
            const nextEntry = stscEntries[i + 1];
            if (chunkIndex >= entry.firstChunk && (!nextEntry || chunkIndex < nextEntry.firstChunk)) {
                samplesPerChunk = entry.samplesPerChunk;
                break;
            }
        }

        let offsetInChunk = 0;
        for (let i = 0; i < samplesPerChunk; i++) {
            const size = sampleSizes[sampleIndex];
            const offset = chunkOffsets[chunkIndex - 1] + offsetInChunk;
            const ctsOffset = compositionOffsets ? (compositionOffsets[sampleIndex] || 0) : 0;
            const timestampUs = Math.round(((dts + ctsOffset) / timescale) * 1000000);
            const durationUs = Math.round(((sampleDeltas[sampleIndex] || 0) / timescale) * 1000000);
            const key = syncSamples ? syncSamples.has(sampleIndex + 1) : true;
            samples.push({
                timestampUs,
                ptsUs: timestampUs,
                sampleIndex: sampleIndex,
                durationUs,
                data: new Uint8Array(buffer, offset, size),
                type: key ? 'key' : 'delta'
            });
            offsetInChunk += size;
            dts += sampleDeltas[sampleIndex] || 0;
            sampleIndex++;
            if (sampleIndex >= sampleCount) break;
        }
    }

    // Build codec string based on codec type
    let codec;
    let description = null;

    if (codecType === 'avc1' && avcC && avcC.length >= 4) {
        // H.264: construct codec string from avcC
        const profile = avcC[1];
        const compat = avcC[2];
        const level = avcC[3];
        codec = `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
        description = avcC.buffer.slice(avcC.byteOffset, avcC.byteOffset + avcC.byteLength);
    } else if (['hvc1', 'hev1'].includes(codecType)) {
        // HEVC: use codec type as-is, include hvcC if available
        codec = codecType;
        if (avcC) {
            description = avcC.buffer.slice(avcC.byteOffset, avcC.byteOffset + avcC.byteLength);
        }
        console.log(`📦 HEVC video detected: ${codec}, WebCodecs may not support, will use playback method`);
    } else {
        // Other codecs: use as-is
        codec = codecType;
        console.log(`📦 Codec: ${codec}, attempting playback method`);
    }

    const nativeFps = samples.length && duration ? samples.length / (duration / timescale) : null;

    return {
        codec,
        description,
        samples,
        width,
        height,
        duration: duration / timescale,
        nativeFps
    };
}

function readEbmlElement(view, offset, end) {
    if (offset >= end) return null;
    const idInfo = readVint(view, offset, false);
    const sizeInfo = readVint(view, offset + idInfo.length, true);
    const dataStart = offset + idInfo.length + sizeInfo.length;
    const dataEnd = sizeInfo.value === -1 ? end : dataStart + sizeInfo.value;
    return {
        id: idInfo.value,
        start: offset,
        dataStart,
        dataEnd,
        size: sizeInfo.value,
        headerSize: idInfo.length + sizeInfo.length
    };
}

function findSequence(u8, start, end, seq) {
    for (let i = start; i + seq.length <= end; i++) {
        let match = true;
        for (let j = 0; j < seq.length; j++) {
            if (u8[i + j] !== seq[j]) {
                match = false;
                break;
            }
        }
        if (match) return i;
    }
    return -1;
}

function readVintSigned(view, offset) {
    const info = readVint(view, offset, true);
    const valueBits = 7 * info.length;
    const bias = Math.pow(2, valueBits - 1) - 1;
    return {
        value: info.value - bias,
        length: info.length
    };
}

function parseSimpleBlock(buffer, blockStart, blockEnd, clusterTimecode, timecodeScale, videoTrackNumber) {
    const blockView = new DataView(buffer, blockStart, blockEnd - blockStart);
    const trackInfo = readVint(blockView, 0, true);
    const trackNumber = trackInfo.value;
    const timecode = blockView.getInt16(trackInfo.length, false);
    const flags = blockView.getUint8(trackInfo.length + 2);
    const lacing = (flags >> 1) & 0x03;
    if (trackNumber !== videoTrackNumber) {
        return [];
    }

    const timestampNs = (clusterTimecode + timecode) * timecodeScale;
    const baseTimestampUs = Math.round(timestampNs / 1000);
    const key = (flags & 0x80) !== 0;
    const headerSize = trackInfo.length + 3;
    if (lacing === 0) {
        const data = new Uint8Array(buffer, blockStart + headerSize, blockEnd - blockStart - headerSize);
        return [{ timestampUs: baseTimestampUs, data, type: key ? 'key' : 'delta' }];
    }

    let cursor = headerSize;
    const numFrames = blockView.getUint8(cursor) + 1;
    cursor += 1;
    const sizes = [];
    if (lacing === 1) {
        for (let i = 0; i < numFrames - 1; i++) {
            let size = 0;
            while (cursor < blockEnd - blockStart) {
                const byte = blockView.getUint8(cursor++);
                size += byte;
                if (byte !== 255) break;
            }
            sizes.push(size);
        }
    } else if (lacing === 2) {
        const remaining = blockEnd - blockStart - cursor;
        const size = Math.floor(remaining / numFrames);
        for (let i = 0; i < numFrames - 1; i++) {
            sizes.push(size);
        }
    } else if (lacing === 3) {
        const first = readVint(blockView, cursor, true);
        let size = first.value;
        sizes.push(size);
        cursor += first.length;
        for (let i = 1; i < numFrames - 1; i++) {
            const diff = readVintSigned(blockView, cursor);
            cursor += diff.length;
            size += diff.value;
            sizes.push(size);
        }
    }

    const totalKnown = sizes.reduce((sum, val) => sum + val, 0);
    const remaining = blockEnd - blockStart - cursor;
    const lastSize = remaining - totalKnown;
    if (lastSize < 0) return [];
    sizes.push(lastSize);

    const samples = [];
    let dataOffset = blockStart + cursor;
    for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i];
        if (size <= 0) continue;
        const data = new Uint8Array(buffer, dataOffset, size);
        samples.push({
            timestampUs: baseTimestampUs + i,
            data,
            type: key ? 'key' : 'delta'
        });
        dataOffset += size;
    }
    return samples;
}

function parseWebm(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const EBML_ID = 0x1A45DFA3;
    const SEGMENT_ID = 0x18538067;
    const INFO_ID = 0x1549A966;
    const TIMECODE_SCALE_ID = 0x2AD7B1;
    const TRACKS_ID = 0x1654AE6B;
    const TRACK_ENTRY_ID = 0xAE;
    const TRACK_NUMBER_ID = 0xD7;
    const TRACK_TYPE_ID = 0x83;
    const CODEC_ID = 0x86;
    const VIDEO_ID = 0xE0;
    const PIXEL_WIDTH_ID = 0xB0;
    const PIXEL_HEIGHT_ID = 0xBA;
    const DISPLAY_WIDTH_ID = 0x54B0;
    const DISPLAY_HEIGHT_ID = 0x54BA;
    const CLUSTER_ID = 0x1F43B675;
    const TIMECODE_ID = 0xE7;
    const SIMPLE_BLOCK_ID = 0xA3;
    const BLOCK_GROUP_ID = 0xA0;
    const BLOCK_ID = 0xA1;

    let offset = 0;
    let segment = null;
    while (offset < view.byteLength) {
        const el = readEbmlElement(view, offset, view.byteLength);
        if (!el) break;
        if (el.id === EBML_ID || el.id === SEGMENT_ID) {
            if (el.id === SEGMENT_ID) {
                segment = el;
                break;
            }
        }
        offset = el.dataEnd;
    }
    if (!segment) {
        throw new Error('WebM segment not found');
    }

    let timecodeScale = 1000000;
    let videoTrackNumber = null;
    let codecId = null;
    let width = 0;
    let height = 0;

    let ptr = segment.dataStart;
    while (ptr < segment.dataEnd) {
        const el = readEbmlElement(view, ptr, segment.dataEnd);
        if (!el) break;
        if (el.id === INFO_ID) {
            let infoPtr = el.dataStart;
            while (infoPtr < el.dataEnd) {
                const infoEl = readEbmlElement(view, infoPtr, el.dataEnd);
                if (!infoEl) break;
                if (infoEl.id === TIMECODE_SCALE_ID) {
                    timecodeScale = readEbmlUnsigned(view, infoEl.dataStart, infoEl.dataEnd);
                }
                infoPtr = infoEl.dataEnd;
            }
        } else if (el.id === TRACKS_ID) {
            let trackPtr = el.dataStart;
            while (trackPtr < el.dataEnd) {
                const trackEl = readEbmlElement(view, trackPtr, el.dataEnd);
                if (!trackEl) break;
                if (trackEl.id === TRACK_ENTRY_ID) {
                    let entryPtr = trackEl.dataStart;
                    let trackNumber = null;
                    let trackType = null;
                    let entryCodecId = null;
                    let entryWidth = 0;
                    let entryHeight = 0;
                    let displayWidth = 0;
                    let displayHeight = 0;
                    while (entryPtr < trackEl.dataEnd) {
                        const entryEl = readEbmlElement(view, entryPtr, trackEl.dataEnd);
                        if (!entryEl) break;
                        if (entryEl.id === TRACK_NUMBER_ID) {
                            trackNumber = readEbmlUnsigned(view, entryEl.dataStart, entryEl.dataEnd);
                        } else if (entryEl.id === TRACK_TYPE_ID) {
                            trackType = readEbmlUnsigned(view, entryEl.dataStart, entryEl.dataEnd);
                        } else if (entryEl.id === CODEC_ID) {
                            entryCodecId = readString(view, entryEl.dataStart, entryEl.dataEnd - entryEl.dataStart);
                        } else if (entryEl.id === VIDEO_ID) {
                            let videoPtr = entryEl.dataStart;
                            while (videoPtr < entryEl.dataEnd) {
                                const videoEl = readEbmlElement(view, videoPtr, entryEl.dataEnd);
                                if (!videoEl) break;
                                if (videoEl.id === PIXEL_WIDTH_ID) {
                                    entryWidth = readEbmlUnsigned(view, videoEl.dataStart, videoEl.dataEnd);
                                } else if (videoEl.id === PIXEL_HEIGHT_ID) {
                                    entryHeight = readEbmlUnsigned(view, videoEl.dataStart, videoEl.dataEnd);
                                } else if (videoEl.id === DISPLAY_WIDTH_ID) {
                                    displayWidth = readEbmlUnsigned(view, videoEl.dataStart, videoEl.dataEnd);
                                } else if (videoEl.id === DISPLAY_HEIGHT_ID) {
                                    displayHeight = readEbmlUnsigned(view, videoEl.dataStart, videoEl.dataEnd);
                                }
                                videoPtr = videoEl.dataEnd;
                            }
                        }
                        entryPtr = entryEl.dataEnd;
                    }
                    if (trackType === 1) {
                        videoTrackNumber = trackNumber;
                        codecId = entryCodecId;
                        width = entryWidth || displayWidth;
                        height = entryHeight || displayHeight;
                    }
                }
                trackPtr = trackEl.dataEnd;
            }
        }
        ptr = el.dataEnd;
    }

    if (!videoTrackNumber || !codecId) {
        throw new Error('WebM video track not found');
    }

    let codec;
    if (codecId === 'V_VP8') {
        codec = 'vp8';
    } else if (codecId === 'V_VP9') {
        codec = 'vp09.00.10.08';
    } else {
        throw new Error('WebM codec not supported: ' + codecId);
    }

    const samples = [];
    const clusterMarker = [0x1F, 0x43, 0xB6, 0x75];
    let segPtr = segment.dataStart;
    while (segPtr < segment.dataEnd) {
        const el = readEbmlElement(view, segPtr, segment.dataEnd);
        if (!el) break;
        if (el.id === CLUSTER_ID) {
            let clusterEnd = el.dataEnd;
            if (el.size === -1) {
                const nextCluster = findSequence(u8, el.dataStart, segment.dataEnd, clusterMarker);
                clusterEnd = nextCluster === -1 ? segment.dataEnd : nextCluster;
            }
            let clusterTimecode = 0;
            let clusterPtr = el.dataStart;
            while (clusterPtr < clusterEnd) {
                const clusterEl = readEbmlElement(view, clusterPtr, clusterEnd);
                if (!clusterEl) break;
                if (clusterEl.id === TIMECODE_ID) {
                    clusterTimecode = readEbmlUnsigned(view, clusterEl.dataStart, clusterEl.dataEnd);
                } else if (clusterEl.id === SIMPLE_BLOCK_ID) {
                    const blockSamples = parseSimpleBlock(
                        buffer,
                        clusterEl.dataStart,
                        clusterEl.dataEnd,
                        clusterTimecode,
                        timecodeScale,
                        videoTrackNumber
                    );
                    if (blockSamples.length) {
                        samples.push(...blockSamples);
                    }
                } else if (clusterEl.id === BLOCK_GROUP_ID) {
                    let groupPtr = clusterEl.dataStart;
                    let block = null;
                    while (groupPtr < clusterEl.dataEnd) {
                        const groupEl = readEbmlElement(view, groupPtr, clusterEl.dataEnd);
                        if (!groupEl) break;
                        if (groupEl.id === BLOCK_ID) {
                            block = groupEl;
                            break;
                        }
                        groupPtr = groupEl.dataEnd;
                    }
                    if (block) {
                        const blockSamples = parseSimpleBlock(
                            buffer,
                            block.dataStart,
                            block.dataEnd,
                            clusterTimecode,
                            timecodeScale,
                            videoTrackNumber
                        );
                        if (blockSamples.length) {
                            samples.push(...blockSamples);
                        }
                    }
                }
                clusterPtr = clusterEl.dataEnd;
            }
            if (el.size === -1) {
                segPtr = clusterEnd;
                continue;
            }
        }
        segPtr = el.dataEnd;
    }

    samples.sort((a, b) => a.timestampUs - b.timestampUs);
    const duration = samples.length ? (samples[samples.length - 1].timestampUs / 1000000) : 0;
    if (!samples.length) {
        throw new Error('WebM parsing failed.');
    }

    return { codec, samples, width, height, duration };
}

class WebMMuxer {
    constructor(fps, width, height, duration) {
        this.data = [];
        this.width = width;
        this.height = height;
        this.duration = duration * 1000;
        this.clusterTime = 0;
        this.writeHeader();
    }

    push(data) {
        this.data.push(data);
    }

    writeVarInt(num) {
        let len = 1;
        if (num < 127) len = 1;
        else if (num < 16383) len = 2;
        else if (num < 2097151) len = 3;
        else len = 4;

        let arr = [];
        if (len === 1) {
            arr.push(num | 0x80);
        } else if (len === 2) {
            arr.push((num >> 8) | 0x40, num & 0xFF);
        } else if (len === 3) {
            arr.push((num >> 16) | 0x20, (num >> 8) & 0xFF, num & 0xFF);
        } else {
            arr.push((num >> 24) | 0x10, (num >> 16) & 0xFF, (num >> 8) & 0xFF, num & 0xFF);
        }
        this.push(new Uint8Array(arr));
    }

    writeHeader() {
        this.push(new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]));
        const ebml = [
            0x42, 0x86, 0x81, 0x01,
            0x42, 0xF7, 0x81, 0x01,
            0x42, 0xF2, 0x81, 0x04,
            0x42, 0xF3, 0x81, 0x08,
            0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
            0x42, 0x87, 0x81, 0x02,
            0x42, 0x85, 0x81, 0x02
        ];
        this.writeVarInt(ebml.length);
        this.push(new Uint8Array(ebml));

        this.push(new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));

        this.push(new Uint8Array([0x15, 0x49, 0xA9, 0x66]));
        const info = [
            0x2A, 0xD7, 0xB1, 0x83, 0x0F, 0x42, 0x40,
            0x4D, 0x80, 0x84, 0x4D, 0x75, 0x78, 0x65,
            0x57, 0x41, 0x84, 0x4D, 0x75, 0x78, 0x65
        ];

        if (this.duration > 0) {
            info.push(0x44, 0x89);
            const view = new DataView(new ArrayBuffer(4));
            view.setFloat32(0, this.duration);
            info.push(0x84, view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        }

        this.writeVarInt(info.length);
        this.push(new Uint8Array(info));

        this.push(new Uint8Array([0x16, 0x54, 0xAE, 0x6B]));
        const trackEntry = [
            0xD7, 0x81, 0x01,
            0x73, 0xC5, 0x81, 0x01,
            0x83, 0x81, 0x01,
            0x9C, 0x81, 0x00,
            0x86, 0x85, 0x56, 0x5F, 0x56, 0x50, 0x39,
            0xE0
        ];

        const video = [
            0xB0, 0x82, (this.width >> 8) & 0xFF, this.width & 0xFF,
            0xBA, 0x82, (this.height >> 8) & 0xFF, this.height & 0xFF
        ];

        trackEntry.push(0x80 | video.length, ...video);
        this.writeVarInt(trackEntry.length + 2);
        this.push(new Uint8Array([0xAE]));
        this.writeVarInt(trackEntry.length);
        this.push(new Uint8Array(trackEntry));
    }

    add(chunk, meta) {
        const ms = Math.round(chunk.timestamp / 1000);
        const isKey = chunk.type === 'key';

        if (this.clusterTime === 0 || ms - this.clusterTime > 2000) {
            this.clusterTime = ms;
            this.push(new Uint8Array([0x1F, 0x43, 0xB6, 0x75, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
            this.push(new Uint8Array([0xE7]));
            const tc = Math.round(ms);
            const tcBytes = [(tc >> 24) & 0xFF, (tc >> 16) & 0xFF, (tc >> 8) & 0xFF, tc & 0xFF];
            this.writeVarInt(4);
            this.push(new Uint8Array(tcBytes));
        }

        const relativeTime = ms - this.clusterTime;
        if (relativeTime >= 0 && relativeTime < 32767) {
            this.push(new Uint8Array([0xA3]));
            const size = 4 + chunk.byteLength;
            this.writeVarInt(size);
            this.push(new Uint8Array([
                0x81,
                (relativeTime >> 8) & 0xFF,
                relativeTime & 0xFF,
                isKey ? 0x80 : 0x00
            ]));

            const buffer = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buffer);
            this.push(buffer);
        }
    }

    getBlob() {
        return new Blob(this.data, { type: 'video/webm' });
    }
}

function createEncodingCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
}

async function demuxVideoFile(videoFile) {
    const buffer = await videoFile.arrayBuffer();
    const lowerName = (videoFile.name || '').toLowerCase();
    if (videoFile.type === 'video/webm' || lowerName.endsWith('.webm')) {
        return parseWebm(buffer);
    }
    return parseMp4(buffer);
}

async function extractFramesWithPlayback(videoFile, demuxed, options = {}) {
    const url = URL.createObjectURL(videoFile);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('Video metadata failed to load.'));
    });

    const duration = Number.isFinite(video.duration) ? video.duration : (demuxed && demuxed.duration) || 0;
    const width = video.videoWidth || (demuxed && demuxed.width) || 0;
    const height = video.videoHeight || (demuxed && demuxed.height) || 0;
    const sampleSize = options.sampleSize || 16;
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = sampleSize;
    sampleCanvas.height = sampleSize;
    const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    const useDirectBitmap = options.useDirectBitmap !== false && typeof createImageBitmap === 'function';
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = width;
    fullCanvas.height = height;
    const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });

    let lastHash = null;
    const frames = [];
    const onProgress = options.onProgress;
    let totalSamples = 0;
    let stopped = false;
    let resolveCapture = null;
    let skippedPlaybackCount = 0;

    function captureFrame() {
        sampleCtx.drawImage(video, 0, 0, sampleSize, sampleSize);
        const data = sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
            hash = (hash + data[i] + data[i + 1] + data[i + 2]) >>> 0;
        }
        if (hash !== lastHash) {
            lastHash = hash;
            return (async () => {
                let bitmap;
                if (useDirectBitmap) {
                    bitmap = await createImageBitmap(video);
                } else {
                    fullCtx.drawImage(video, 0, 0, width, height);
                    bitmap = await createImageBitmap(fullCanvas);
                }
                frames.push(bitmap);
            })();
        } else {
            skippedPlaybackCount++;
        }
        return Promise.resolve();
    }

    const baseRate = options.playbackRate || 1.0;
    const fallbackRate = Number.isFinite(options.playbackRateFallback)
        ? options.playbackRateFallback
        : baseRate * 0.5;
    const supportsRVFC = typeof video.requestVideoFrameCallback === 'function';
    video.playbackRate = supportsRVFC ? baseRate : fallbackRate;

    const playbackDone = new Promise((resolve, reject) => {
        video.onended = () => {
            stopped = true;
            if (resolveCapture) resolveCapture();
            resolve();
        };
        video.onerror = () => reject(new Error('Video playback failed.'));
    });

    const captureLoop = new Promise(resolve => {
        resolveCapture = resolve;
        if (supportsRVFC) {
            const onFrame = async () => {
                if (stopped) {
                    resolve();
                    return;
                }
                totalSamples += 1;
                await captureFrame();
                if (onProgress && duration) {
                    const expectedFrames = Math.max(1, Math.round(duration * (estimateFps(demuxed) || 30)));
                    onProgress({
                        decodedFrames: frames.length,
                        expectedFrames,
                        sampleIndex: totalSamples,
                        totalSamples: expectedFrames
                    });
                }
                video.requestVideoFrameCallback(onFrame);
            };
            video.requestVideoFrameCallback(onFrame);
        } else {
            const fps = estimateFps(demuxed) || 30;
            const intervalMs = 1000 / (fps * 2);
            const timer = setInterval(async () => {
                if (stopped) {
                    clearInterval(timer);
                    resolve();
                    return;
                }
                totalSamples += 1;
                await captureFrame();
            }, intervalMs);
        }
    });

    await video.play();
    await Promise.all([playbackDone, captureLoop]);
    await captureFrame();
    video.pause();
    URL.revokeObjectURL(url);

    console.log(`📊 Playback summary: ${frames.length} unique frames captured (${skippedPlaybackCount} duplicates skipped)`);

    return { frames, width, height, duration };
}

async function extractFramesWithWebCodecs(videoFile, demuxed, options = {}) {
    // 1. Browser support check
    if (!('VideoDecoder' in window)) {
        throw new Error('WebCodecs API not supported in this browser');
    }

    // 2. Validate demuxed data
    if (!demuxed || !demuxed.samples || !demuxed.samples.length) {
        throw new Error('No video samples found in demuxed data');
    }

    console.log('📦 Demuxed data:', {
        codec: demuxed.codec,
        width: demuxed.width,
        height: demuxed.height,
        samples: demuxed.samples.length,
        hasDescription: !!demuxed.description
    });

    // 3. Get dimensions from video element if not available from demuxer
    let width = demuxed.width;
    let height = demuxed.height;

    if (!width || !height) {
        console.log('⚠️ Width/height missing from demuxer, loading video element to get dimensions...');
        const video = document.createElement('video');
        const url = URL.createObjectURL(videoFile);
        video.src = url;

        await new Promise((resolve, reject) => {
            video.onloadedmetadata = () => {
                width = video.videoWidth;
                height = video.videoHeight;
                console.log('✓ Got dimensions from video element:', width, 'x', height);
                resolve();
            };
            video.onerror = () => reject(new Error('Failed to load video metadata'));
        });

        URL.revokeObjectURL(url);

        if (!width || !height) {
            throw new Error(`Invalid video dimensions: ${width}x${height}`);
        }
    }

    // 4. Setup for deduplication (optional, disabled by default for VFR accuracy)
    const skipDuplicates = options.skipDuplicates !== undefined ? options.skipDuplicates : false;
    const sampleSize = options.sampleSize || 16;
    const sampleCanvas = skipDuplicates ? document.createElement('canvas') : null;
    const sampleCtx = skipDuplicates ? (() => {
        sampleCanvas.width = sampleSize;
        sampleCanvas.height = sampleSize;
        return sampleCanvas.getContext('2d', { willReadFrequently: true });
    })() : null;

    let lastHash = null;
    const frames = [];
    const onProgress = options.onProgress;
    let decodedCount = 0;
    let skippedCount = 0;
    let lastTimestamp = -1;
    let duplicateTimestampCount = 0;

    // Track timestamps to detect frame loss
    const expectedTimestamps = demuxed.samples.map(s => s.timestampUs || 0);
    const receivedTimestamps = [];

    // 4. Create VideoDecoder with output handler
    return new Promise(async (resolve, reject) => {
        const decoder = new VideoDecoder({
            output: async (videoFrame) => {
                try {
                    let shouldCapture = true;

                    // Track received timestamp
                    receivedTimestamps.push(videoFrame.timestamp);

                    // Detect duplicate timestamps (indicates decoder is outputting duplicate frames)
                    if (videoFrame.timestamp === lastTimestamp) {
                        console.warn(`⚠️ Duplicate timestamp detected: ${videoFrame.timestamp}µs - frame ${decodedCount}`);
                        duplicateTimestampCount++;
                    }
                    lastTimestamp = videoFrame.timestamp;

                    // Optional hash-based deduplication
                    if (skipDuplicates) {
                        sampleCtx.drawImage(videoFrame, 0, 0, sampleSize, sampleSize);
                        const data = sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data;
                        let hash = 0;
                        for (let i = 0; i < data.length; i += 4) {
                            hash = (hash + data[i] + data[i + 1] + data[i + 2]) >>> 0;
                        }

                        if (hash !== lastHash) {
                            lastHash = hash;
                        } else {
                            shouldCapture = false;
                            skippedCount++;
                            console.log(`⏭️ Skipped duplicate frame ${decodedCount} (hash: ${hash})`);
                        }
                    }

                    if (shouldCapture) {
                        // Convert VideoFrame to ImageBitmap for consistent storage
                        const bitmap = await createImageBitmap(videoFrame);
                        frames.push(bitmap);
                    }

                    // CRITICAL: Close VideoFrame to prevent memory leak
                    videoFrame.close();

                    decodedCount++;

                    // Update progress as frames are decoded
                    if (onProgress) {
                        onProgress({
                            decodedFrames: frames.length,
                            expectedFrames: totalSamples,
                            sampleIndex: decodedCount,
                            totalSamples: totalSamples
                        });
                    }

                } catch (error) {
                    console.error('Frame output error:', error);
                    videoFrame.close(); // Still close on error
                }
            },
            error: (error) => {
                console.error('VideoDecoder error:', error);
                decoder.close();
                reject(new Error(`WebCodecs decode error: ${error.message}`));
            }
        });

        // 5. Configure decoder based on codec type
        try {
            const config = {
                codec: demuxed.codec,
                codedWidth: width,
                codedHeight: height,
                optimizeForLatency: true
            };

            // H.264/AVC requires description (avcC box), VP8/VP9 do not
            if (demuxed.description) {
                config.description = demuxed.description;
            }

            decoder.configure(config);

        } catch (error) {
            decoder.close();
            reject(new Error(`WebCodecs config error: ${error.message}`));
            return;
        }

        // 6. Process all samples (no skipping for VFR accuracy)
        let processedSamples = 0;
        const totalSamples = demuxed.samples.length;

        try {
            for (let i = 0; i < totalSamples; i++) {
                const sample = demuxed.samples[i];

                // Create EncodedVideoChunk from sample data
                const chunk = new EncodedVideoChunk({
                    type: sample.type,           // 'key' or 'delta'
                    timestamp: sample.timestampUs || 0,
                    duration: sample.durationUs || 0,
                    data: sample.data            // Uint8Array
                });

                decoder.decode(chunk);
                processedSamples++;

                // Backpressure: wait if decode queue is getting too large (mobile Safari/Chrome fix)
                // This prevents frames from being dropped on memory-constrained devices
                if (decoder.decodeQueueSize > 10) {
                    await new Promise(resolve => {
                        const checkQueue = () => {
                            if (decoder.decodeQueueSize <= 5) {
                                resolve();
                            } else {
                                setTimeout(checkQueue, 10);
                            }
                        };
                        checkQueue();
                    });
                }
            }

            // 7. Flush decoder and wait for all frames
            decoder.flush().then(() => {
                decoder.close();

                // Final progress update
                if (onProgress) {
                    onProgress({
                        decodedFrames: frames.length,
                        expectedFrames: totalSamples,
                        sampleIndex: totalSamples,
                        totalSamples: totalSamples
                    });
                }

                // Detailed frame loss analysis
                console.group('🔍 WebCodecs Frame Analysis');
                console.log(`Expected samples: ${totalSamples}`);
                console.log(`Received frames: ${receivedTimestamps.length}`);
                console.log(`Stored frames: ${frames.length}`);

                if (skipDuplicates) {
                    console.log(`📊 ${totalSamples} samples → ${frames.length} unique frames (${skippedCount} duplicates removed)`);
                } else {
                    console.log(`📊 ${totalSamples} samples → ${frames.length} frames (deduplication disabled)`);
                }

                // Check for missing timestamps
                const receivedSet = new Set(receivedTimestamps);
                const missingTimestamps = expectedTimestamps.filter(ts => !receivedSet.has(ts));

                if (missingTimestamps.length > 0) {
                    console.error(`❌ FRAME LOSS: ${missingTimestamps.length} frames never received from decoder!`);
                    console.error('Missing timestamps (µs):', missingTimestamps.slice(0, 10));
                    if (missingTimestamps.length > 10) {
                        console.error(`... and ${missingTimestamps.length - 10} more`);
                    }
                }

                // Check for duplicate timestamps
                if (duplicateTimestampCount > 0) {
                    console.error(`❌ DUPLICATE FRAMES: ${duplicateTimestampCount} frames with duplicate timestamps!`);
                    console.error(`This means the decoder output the same frame multiple times.`);
                }

                // Check for unexpected timestamps (frames we didn't queue)
                const expectedSet = new Set(expectedTimestamps);
                const unexpectedTimestamps = receivedTimestamps.filter(ts => !expectedSet.has(ts));
                if (unexpectedTimestamps.length > 0) {
                    console.warn(`⚠️ UNEXPECTED FRAMES: ${unexpectedTimestamps.length} frames with unexpected timestamps`);
                    console.warn('Unexpected timestamps (µs):', unexpectedTimestamps.slice(0, 10));
                }

                // Summary
                if (missingTimestamps.length === 0 && duplicateTimestampCount === 0 && unexpectedTimestamps.length === 0) {
                    console.log('✅ All frames decoded successfully!');
                } else {
                    console.error('⚠️ Frame loss/duplication detected. Consider using playback method on this device.');
                }
                console.groupEnd();

                resolve({
                    frames: frames,
                    width: width,
                    height: height,
                    duration: demuxed.duration
                });

            }).catch((error) => {
                decoder.close();
                reject(new Error(`WebCodecs flush error: ${error.message}`));
            });

        } catch (error) {
            decoder.close();
            // Clean up any frames created before error
            frames.forEach(frame => {
                if (frame.close) frame.close();
            });
            reject(new Error(`WebCodecs sample processing error: ${error.message}`));
        }
    });
}

async function extractFramesWithMeta(videoFile, options = {}) {
    console.log('⚙️ Frame extraction options:', { useWebCodecs: options.useWebCodecs, hasVideoDecoder: 'VideoDecoder' in window });

    // Demux video file to get codec info and samples
    const demuxed = options.demuxed || await demuxVideoFile(videoFile);
    const inferredFps = estimateFps(demuxed);
    const duration = demuxed && demuxed.duration ? demuxed.duration : 0;
    const bitrate = estimateBitrate(videoFile.size, duration);
    const fpsForDecode = inferredFps || options.fallbackFps || 30;

    let result;
    let extractionMethod = 'playback'; // Track which method was used

    // Try WebCodecs if requested and supported
    if (options.useWebCodecs && 'VideoDecoder' in window) {
        try {
            console.log('🚀 USING WEBCODECS EXTRACTION');
            const startTime = performance.now();

            result = await extractFramesWithWebCodecs(videoFile, demuxed, {
                ...options,
                fallbackFps: fpsForDecode
            });

            const extractionTime = performance.now() - startTime;
            console.log(`WebCodecs extraction completed in ${extractionTime.toFixed(2)}ms`);
            extractionMethod = 'webcodecs';

        } catch (error) {
            console.warn('WebCodecs extraction failed, falling back to playback method:', error);

            // Fallback to playback method
            result = await extractFramesWithPlayback(videoFile, demuxed, {
                ...options,
                fallbackFps: fpsForDecode
            });
            extractionMethod = 'playback-fallback';
        }
    } else {
        // Use playback method (default or WebCodecs not available)
        console.log('📹 USING PLAYBACK EXTRACTION (WebCodecs disabled or not supported)');
        result = await extractFramesWithPlayback(videoFile, demuxed, {
            ...options,
            fallbackFps: fpsForDecode
        });
    }

    // Return enhanced result with metadata
    return {
        ...result,
        demuxed,
        inferredFps,
        bitrate,
        fpsForDecode,
        extractionMethod  // NEW: Track which method was used
    };
}

async function encodeFramesWithCanvas(options) {
    const width = options.width;
    const height = options.height;
    const fps = options.fps;
    const bitrate = options.bitrate;
    const frameCount = options.frameCount;
    const getFrame = options.getFrame;
    const drawFrame = options.drawFrame;
    const onProgress = options.onProgress;

    const muxer = new WebMMuxer(fps, width, height, frameCount / fps);
    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.add(chunk, meta),
        error: e => { throw e; }
    });

    const encoderConfig = {
        codec: 'vp09.00.10.08',
        width: width,
        height: height,
        bitrate: bitrate,
        framerate: fps
    };
    if (VideoEncoder.isConfigSupported) {
        const support = await VideoEncoder.isConfigSupported(encoderConfig);
        if (!support.supported) {
            throw new Error('Encoder config not supported for codec: ' + encoderConfig.codec);
        }
    }
    encoder.configure(encoderConfig);

    const { canvas, ctx } = createEncodingCanvas(width, height);
    for (let i = 0; i < frameCount; i++) {
        const frame = getFrame(i);
        if (!frame) {
            throw new Error('Frame not available at index ' + i);
        }
        if (drawFrame) {
            drawFrame(ctx, frame, i);
        } else {
            ctx.drawImage(frame, 0, 0, width, height);
        }
        const videoFrame = new VideoFrame(canvas, { timestamp: i * (1000000 / fps) });
        encoder.encode(videoFrame, { keyFrame: i % (fps * 2) === 0 });
        videoFrame.close();
        if (onProgress) {
            onProgress({ encodedFrames: i + 1, totalFrames: frameCount });
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    await encoder.flush();
    encoder.close();
    return muxer.getBlob();
}

function createFramePlayback(options) {
    const getTotalFrames = options.getTotalFrames;
    const getCurrentFrame = options.getCurrentFrame;
    const drawFrame = options.drawFrame;
    const getFps = options.getFps;
    const onStart = options.onStart;
    const onStop = options.onStop;

    let playing = false;
    let interval = null;

    function start() {
        if (playing) return;
        const total = getTotalFrames();
        if (!total) return;
        playing = true;
        if (onStart) onStart();
        const frameTime = 1000 / (getFps() || 1);
        interval = setInterval(() => {
            const currentTotal = getTotalFrames();
            if (!currentTotal) {
                stop();
                return;
            }
            let current = getCurrentFrame();
            if (!Number.isFinite(current) || current < 0 || current >= currentTotal) {
                current = 0;
            }
            const next = current >= currentTotal - 1 ? 0 : current + 1;
            drawFrame(next);
        }, frameTime);
    }

    function stop() {
        playing = false;
        if (onStop) onStop();
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
    }

    function toggle() {
        if (playing) {
            stop();
        } else {
            start();
        }
    }

    return { start, stop, toggle, isPlaying: () => playing };
}
