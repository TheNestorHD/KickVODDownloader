# Host reject detection code (Auto-DL)

```js
let lastHostRejection = 0;

function findHostRejectButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    const textMatches = (text) => {
        const cleaned = text.toLowerCase();
        return cleaned.includes('rechazar') || cleaned.includes('reject') || cleaned.includes('decline');
    };

    return candidates.find(btn => {
        const label = btn.getAttribute('aria-label') || '';
        const title = btn.getAttribute('title') || '';
        const text = btn.textContent || '';
        return textMatches(label) || textMatches(title) || textMatches(text);
    });
}

function attemptRejectHost() {
    if (!isStreamerModeEnabled) return;
    const now = Date.now();
    if (now - lastHostRejection < 2000) return;
    const rejectBtn = findHostRejectButton();
    if (rejectBtn && !rejectBtn.disabled) {
        rejectBtn.click();
        lastHostRejection = now;
        console.log('[KVD] Host rejected while Auto-DL active.');
    }
}
```
