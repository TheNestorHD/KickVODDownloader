// Background service worker
console.log('Kick VOD Downloader: Background service worker loaded.');

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_PROGRESS') {
        if (message.progress !== null && message.progress !== undefined) {
            // Set badge text to percentage globally (no tabId) so it's visible everywhere
            chrome.action.setBadgeText({ text: `${message.progress}%` });
            chrome.action.setBadgeBackgroundColor({ color: '#53fc18' });
        } else {
            // Clear badge globally
            chrome.action.setBadgeText({ text: '' });
        }
    }
});
