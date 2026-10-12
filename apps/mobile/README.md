# Aerolith Core phone app

A [Capacitor](https://capacitorjs.com) (MIT) shell around one deployment's web app. Plan: `docs/wave6-plan.md`
step 4.

## What the shell is

- The web app is already an **installable app** with an offline cache (`apps/web/public/sw.js`) and an outbox for
  the site forms: daily report, attendance, goods receipt, store issue, quality checklist. Phones can use it today
  through "Add to Home screen".
- This shell opens the deployment's own URL. The phone keeps the same session cookie and service worker as the
  browser. It adds:
  - a store listing;
  - the Android and iOS permission prompts for the camera (photo fields use `capture`) and location (site
    check-in).
- No code is copied into the store package. An update to the server updates the phone app.

## Building, on a machine with the SDKs

Android needs Android Studio and a JDK; iOS needs a Mac with Xcode. Neither is in the build container.

```sh
pnpm install
AEROLITH_SERVER_URL=https://erp.example.in pnpm --filter @aerolith/mobile android   # or: ios
npx cap open android                                                                # sign and build in Android Studio
```

The `android/` and `ios/` projects are generated per deployment and are not committed. The upload key or
certificate belongs to whoever publishes the app. Keep it out of this repository.

## Known limits

- **Push notifications are not included.** They need Firebase Cloud Messaging or APNs keys per deployment. The
  in-app inbox still notifies.
- **[Likely] Store review risk.** Apple's guideline 4.2 can reject apps that only wrap a website. If that happens,
  the fix is to bundle `apps/web/dist` as `webDir` with a native secure-storage plugin for the refresh token, as the
  desktop app does with the OS keychain. That is a follow-up, not part of this step.
