# Why each permission

These go into the dashboard's "Privacy practices" tab. Each has one field.

**nativeMessaging**
Desk's extension has exactly one channel: Chrome native messaging to the Desk app installed on the same computer (host `xyz.driftwerk.desk`). Every instruction the extension carries out comes from there, and every result goes back there. There is no other network use.

**tabs**
To open, move and close the tabs in Desk's own window, and to read their address and title, so Desk knows where its page is. The extension never lists, reads or changes tabs it didn't open.

**tabGroups**
To keep Desk's tabs in a group titled "Desk", so the person can always see which tabs Desk is using.

**scripting**
To run the extension's own, packaged functions (read the page's text, click an element, type or fill a field, choose an option, wait for an element) in Desk's own tabs only. No remote code is run, and nothing is injected into any other tab.

**storage**
To remember, for the browser's session, which window and tabs are Desk's (`storage.session`).

**Host permission `<all_urls>`**
Desk works on whatever site the person asks it to (their CRM, their email, a shop), so the extension needs to run its functions, and take a screenshot with `tabs.captureVisibleTab`, on any site, but only in the tabs Desk opened. The person can list sites Desk must never visit, in Desk's settings.

**Remote code:** No. All code is in the package. The extension never evaluates code it receives.

**Data usage** (tick these in the dashboard):
- **Website content.** Page text and screenshots of the pages Desk works on are sent to the Desk app on the same computer.
- **User activity.** The pages Desk opens and the actions it takes there are recorded by the Desk app on the same computer, for the person's own activity list.

Not collected: personally identifiable information, health, financial or payment information, authentication information, personal communications, location, or web history beyond Desk's own tabs.

**Certify:**
- The data is not sold to third parties.
- It is not used or transferred for purposes unrelated to the item's single purpose.
- It is not used or transferred to determine creditworthiness or for lending purposes.
