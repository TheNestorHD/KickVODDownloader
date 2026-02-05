// Background service worker
console.log('Kick VOD Downloader: Background service worker loaded.');
const extensionApi = typeof browser !== 'undefined' ? browser : chrome;
const actionApi = extensionApi.action || extensionApi.browserAction;

// Listen for messages from content script
extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_PROGRESS') {
        if (message.progress !== null && message.progress !== undefined) {
            // Set badge text to percentage globally (no tabId) so it's visible everywhere
            actionApi.setBadgeText({ text: `${message.progress}%` });
            actionApi.setBadgeBackgroundColor({ color: '#53fc18' });
        } else {
            // Clear badge globally
            actionApi.setBadgeText({ text: '' });
        }
    }
    
    // StreamSaver-like functionality using Chrome Downloads API
    // Since we cannot use File System Access API in Brave content scripts easily,
    // we can stream data to background and append it? 
    // No, Chrome Downloads API doesn't support appending to a file.
    // The only way to avoid RAM usage without FS Access API is using a Service Worker stream 
    // which is complex to set up (StreamSaver.js approach) requiring a man-in-the-middle server or strict CSP handling.
    
    // HOWEVER, we can use the "blob" approach in chunks if we download purely via background?
    // No, background script also has memory limits.
    
    // Alternative: Use chrome.downloads.download() with a stream? 
    // Not directly supported for generated content without Blob.
    
    // Real StreamSaver approach requires a service worker to intercept a fetch request.
    // Let's implement a simplified StreamSaver strategy:
    // 1. Content script requests a "download stream" URL.
    // 2. Background SW registers a fetch listener for that URL.
    // 3. Content script POSTs chunks to the SW.
    // 4. SW pipes those chunks to the download stream.
    
    // BUT, in Manifest V3, Service Workers are short-lived. Keeping a stream open is hard.
    // The most robust "no-FS-API" method for long files is actually confusingly hard in MV3.
    
    // Current Decision:
    // Stick to Memory Mode as fallback, but warn user (as requested).
    // Implementing full StreamSaver in MV3 inside an extension without an external server is very hacky/unstable.
});

// Handle Notification Requests
extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SHOW_NOTIFICATION') {
        extensionApi.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: message.title,
            message: message.message,
            priority: 2
        });
    }
});
