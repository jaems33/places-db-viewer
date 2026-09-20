/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const VIEWER_URL = browser.runtime.getURL("content/index.html");

browser.browserAction.onClicked.addListener(async () => {
  // Reuse an already-open viewer tab rather than stacking duplicates.
  const [existing] = await browser.tabs.query({ url: VIEWER_URL });
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url: VIEWER_URL });
});
