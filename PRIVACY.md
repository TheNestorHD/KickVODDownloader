## Privacy Policy for Kick VOD Downloader

**Last Updated:** January 29, 2026

### 1. Introduction
**Kick VOD Downloader** ("the Extension") is a tool developed by TheNestorHD ("the Developer") designed to allow users to download Video on Demand (VOD) content from Kick.com directly to their device. We are committed to protecting your privacy.

### 2. Data Collection
**We do not collect, store, or share any personal data.**
*   **No Registration:** You do not need to create an account, log in, or provide an email address to use the Extension.
*   **No Tracking:** We do not log your IP address, geographic location, or browsing history.
*   **No Analytics:** We do not use third-party analytics services (such as Google Analytics, Mixpanel, etc.) to track user behavior.

### 3. Permissions Usage
The Extension operates entirely locally within your browser. The permissions requested in the `manifest.json` file are used solely for the technical functionality described below:

*   **`activeTab` & `scripting`:** Used to inject the download button into the Kick.com video player interface and run the conversion script (mux.min.js).
*   **`webRequest`:** Used to automatically detect the video stream URL (.m3u8 files) required to start the download.
*   **`downloads`:** Used exclusively to save the resulting video file (MP4) to your computer's download folder, based on your prompt.
*   **`host_permissions` (kick.com):** Allows the extension to interact only with the official Kick website.

### 4. Data Processing and Security
*   **Local Processing:** All video downloading and conversion to MP4 format happens locally on your device utilizing your browser, CPU, and GPU resources.
*   **No Intermediate Servers:** The video file is transferred directly from Kick's Content Delivery Network (CDN) to your hard drive. The data **never** passes through servers owned by the Developer or any third parties.

### 5. Local Storage
The Extension does not use persistent cookies or local storage (`localStorage`) to save long-term user preferences. It only maintains temporary download state (progress percentage) in volatile memory while the tab is open to ensure the process completes successfully.

### 6. Advertising and Monetization
The Extension is completely free and open source.
*   We do not display ads.
*   We do not sell user data.
*   We do not inject promotional content into websites.

### 7. Changes to this Policy
Since the Extension does not collect user data, substantial changes to this policy are unlikely. However, any future updates will be posted in this document and on the project repository.

### 8. Contact
If you have any questions about this privacy policy or the extension's functionality, you can contact the developer at:
📧 **Email:** nestorchapore2016@gmail.com
