// Wrapper to load mp4-muxer as a global variable
// This makes it work like gif.js (loaded via script tag)

(async function() {
    try {
        const module = await import('./mp4-muxer.min.mjs');

        // Make Muxer and ArrayBufferTarget globally available
        window.MP4Muxer = module.Muxer;
        window.MP4ArrayBufferTarget = module.ArrayBufferTarget;
        window.MP4StreamTarget = module.StreamTarget;

        // Dispatch event to signal library is ready
        window.dispatchEvent(new Event('mp4-muxer-ready'));

        console.log('mp4-muxer loaded successfully');
    } catch (error) {
        console.error('Failed to load mp4-muxer:', error);
        window.dispatchEvent(new CustomEvent('mp4-muxer-error', { detail: error }));
    }
})();
