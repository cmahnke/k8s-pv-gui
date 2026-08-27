# Release instructions

How to cut a release of **K8s Volume Explorer**.

---

## 1. Prepare the release

1. Make sure you are on `main` and clean:
   ```sh
   git checkout main
   git pull
   git status          # must be clean
   ```
2. Decide the version. Bump **`version`** in `package.json` and commit:
   ```sh
   npm version patch|minor|major     # updates package.json + creates tag v<version>
   ```
3. Update the README if user-visible behavior changed.

> The version shown in the app's help output and About info comes from
> `package.json`, so never release without bumping it.

## 2. Verify before building

Run the full local pipeline — this is what CI runs too:

```sh
npm ci                 # clean dependency install
npm run typecheck      # tsc --noEmit
npm run build          # esbuild → dist/
npm start              # smoke test against a real cluster if available
```

Manual smoke checklist (against any reachable cluster):

- [ ] Context → namespace → pod → volume selectors cascade correctly
- [ ] Folder navigation works (double-click, breadcrumbs, ⌫)
- [ ] Drag a file out to Finder; drop a file back in
- [ ] Right-click folder → _Download as ZIP…_ saves a valid archive
- [ ] New folder / rename / delete work

## 3. Local builds (optional)

You can package any platform locally — output lands in `release/`:

```sh
npm run dist:mac       # dmg + zip
npm run dist:win       # NSIS installer + portable exe
npm run dist:linux     # AppImage + deb
```

Notes:

- **macOS builds are unsigned by default** (`"identity": null`). For signed
  builds set `CSC_LINK` / `CSC_NAME` env vars (or remove `identity`) and
  rebuild. Notarization additionally needs `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`.
- Windows NSIS builds from macOS may require Wine depending on your
  electron-builder version — prefer building on a Windows machine or CI.
- Linux targets build fine from macOS and Windows.

## 4. CI build via GitHub Actions

Pushing the release tag triggers nothing automatically (the workflow runs on
`main`, PRs, and manual dispatch), so either:

- Push the version bump to `main` and let the workflow produce fresh
  artifacts (`K8s-Volume-Explorer-mac/-win/-linux`), **or**
- Run it manually: _Actions → build → Run workflow_, **or**
- Build locally per platform and use those artifacts instead.

Each successful run uploads one artifact per OS with the packaged installers.

## 5. Create the GitHub release

1. Push commits and tag:
   ```sh
   git push && git push --tags
   ```
2. Gather the installer files (from `release/` or downloaded CI artifacts)
   and generate checksums:
   ```sh
   shasum -a 256 release/*.dmg release/*.zip release/*.exe release/*.AppImage release/*.deb > SHA256SUMS.txt
   ```
3. Create the release with [`gh`](https://cli.github.com):
   ```sh
   gh release create v<version> \
     release/*.dmg release/*.zip \
     release/*.exe \
     release/*.AppImage release/*.deb \
     SHA256SUMS.txt \
     --title "v<version>" \
     --generate-notes
   ```

`--generate-notes` builds the changelog from merged PRs since the last tag;
edit the draft afterwards if needed.

## 6. Post-release checks

- [ ] Release page lists installers for all three platforms + checksums
- [ ] Downloaded macOS dmg mounts and the app launches (unsigned: right-click
      → Open, or `xattr -cr "/Applications/K8s Volume Explorer.app"`)
- [ ] App shows the new version in the title/help output
