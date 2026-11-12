# Submitting Desk to the Chrome Web Store

These steps are for the person who publishes Desk. They take about half an hour, plus Google's review.

## Once: the developer account

1. Go to https://chrome.google.com/webstore/devconsole and sign in with the Google account that should own Desk's listing.
2. Accept the developer agreement and pay the one-time $5 registration fee.
3. Under **Account**, set the publisher's display name ("Driftwerk") and a contact email, and verify the email.

## Build the package

```sh
npm ci
npm run extension:check
npm run extension            # builds extension/dist
cd extension/dist && zip -r ../desk-extension-0.1.0.zip . && cd -
```

The store zip carries no `key` in its manifest: build it without `DESK_EXTENSION_KEY` set.

## Create the item

1. In the developer dashboard, press **New item** and upload `extension/desk-extension-0.1.0.zip`.
2. **Store listing:**
   - Copy the name, summary, description and category from `LISTING.md`.
   - Upload `icon-128.png`, `promo-440x280.png` and the screenshots from this folder.
3. **Privacy practices:**
   - Single purpose: from `LISTING.md`.
   - Each permission's justification, the remote-code answer and the data-usage ticks: from `PERMISSIONS.md`.
   - Privacy policy URL: publish `PRIVACY.md` (for example at https://github.com/driftwerk/workforce-desk/blob/main/extension/store/PRIVACY.md) and paste its address.
4. **Distribution:**
   - Visibility: Public. Choose Unlisted while testing with a few people.
   - Regions: all.

## Tie Desk to the item (before submitting)

The dashboard shows the item's **ID** (32 letters) as soon as the item exists, and its **public key** under **Package → View public key**.

1. Put the ID in `crates/desk-chrome-host/src/lib.rs` as `STORE_ID`. Desk's host then serves that extension, and Settings → Browser's "Add Desk to Chrome" opens its listing.
2. For development builds to share the store's ID, set `DESK_EXTENSION_KEY` to the public key (the base64 between the BEGIN/END lines, on one line) when running `npm run extension`, and `DESK_DEV_EXTENSION_ID` to the same ID when building Desk.
3. Ship a Desk release with the new `STORE_ID`. Until it ships, the published extension can't reach anyone's Desk.

## Submit

Press **Submit for review**.
- The `<all_urls>` host permission and `nativeMessaging` usually mean an in-depth review, which can take a few days to a few weeks.
- If the reviewer asks how to test, say: install Desk from https://github.com/driftwerk/workforce-desk/releases, add the extension, confirm the code Desk shows, then ask an agent in Desk to open a web page.

## Each update

Bump `version` in `extension/manifest.json`, build and zip as above, then **Package → Upload new package** on the item, and submit.
