# Wave 9: the interface, and production readiness

Starts after Wave 8 and its debug pass ([wave8-plan.md](wave8-plan.md)). The same rules: plan, build, test, push, tick;
no paid services; nothing without a permissive licence.

**Legal texts are drafts.** The privacy policy, terms of service, terms and conditions and licence terms written here
are working drafts shaped to Indian law as commonly applied (the DPDP Act 2023, the IT Act 2000 and its rules, the
Indian Contract Act). They must be reviewed by a lawyer before any customer accepts them; each page says so until the
owner marks it reviewed in settings.

## Wave 9a: a consistent interface

1. **Design tokens and components.** One scale for spacing, type, colour (light and dark, checked for contrast), radii
   and elevation in `@aerolith/ui`; buttons, inputs, selects, tabs, cards, tables and badges brought onto it; every
   screen's ad-hoc classes moved to the components.
2. **Feedback that is seen.** Toasts for success and failure (saved, posted, sent); a confirm dialog for every
   destructive or irreversible action (post, cancel, delete, close a period); error dialogs that say what went wrong
   and what to do, with a reference to quote to support; empty states that say how to begin.
3. **Sign-in and sign-out.** A welcome toast after sign-in (who, which company, last sign-in time and place); a
   confirmation after sign-out; a warning before an idle session expires with the choice to stay signed in.
4. **Leaving the app.** In the desktop app, closing the window asks to confirm, and warns when the outbox holds unsent
   site entries or a form has unsaved changes; in the browser, the same warning on unsaved changes before leaving.
5. **Menus, bars and grids.** Sidebar with favourites and recent pages; a status bar (company, financial year,
   connection and outbox state, version, new-release notice); data grids with column choice, resize, reorder, freeze,
   density, saved views and Excel export, remembered per person.
6. **Charts.** One chart style across dashboards (palette checked for colour-blind readers, legends, units, tooltips
   with full figures, a table view of every chart for screen readers and export); drill-down from every chart.
7. **Process flows.** A flow strip on documents that move through stages (requisition → order → receipt → bill →
   payment; measurement → RA bill → certified → received; booking → agreement → demands → possession) showing where
   this one stands, with links to the documents before and after.
8. **Accessibility.** Keyboard reach for every action, focus order and visible focus, labels on every control, and an
   automated check in the browser suite.

## Wave 9b: production readiness

1. **Settings.** One settings area: profile, password and two-factor, notifications, language, theme, date and number
   format; company settings for admins (letterhead, numbering, financial year, books mode, approval rules, backups,
   updates, legal acceptance).
2. **Help.** In-app help per screen (what it is for, the steps, the fields), a searchable help centre built from the
   docs, keyboard shortcuts, "what's new" for each release, and a way to send a support request with diagnostics.
3. **Legal pages.** Privacy policy, terms of service, terms and conditions, licence terms (the product's own terms and
   the third-party notices already shipped); shown at first sign-in for acceptance, versioned, with who accepted
   which version and when; linked from the sign-in screen and the help menu.
4. **Updates.** A release channel the installation checks (signed release manifest; no paid update service): automatic
   or manual updates chosen in settings; the desktop app downloads and installs on restart; the server images update
   through the documented compose command; a "new release" notice in the status bar and on the sign-in screen, with
   the release notes.
5. **Hardening.** Security headers and content security policy reviewed; rate limits; dependency audit in CI; error
   monitoring to a self-hosted log; structured logs with request IDs; health and readiness checks; database
   connection limits; load test of the heaviest screens; backup restore drill.
6. **Release engineering.** Version numbering, changelog from commits, signed desktop installers, release checklist.

## Progress

Each line is ticked when built, tested (unit, integration where it touches the server, and the browser suite for
anything a person sees), committed and pushed.

- [x] 9a.1 Design tokens and components: one spacing, type, colour (light and dark, contrast-checked), radius and
      elevation scale in `@aerolith/ui`; buttons, inputs, selects, tabs, cards, tables and badges on it
- [x] 9a.2 Feedback that is seen: toasts for success and failure; a confirm dialog for every destructive or
      irreversible action; error dialogs that say what went wrong, what to do and a reference to quote; empty states
- [x] 9a.3 Sign-in and sign-out: welcome toast (who, which company, last sign-in), signed-out confirmation, warning
      before an idle session ends with the choice to stay
- [x] 9a.4 Leaving the app: the desktop app asks before closing and warns of unsent site entries or unsaved forms;
      the browser warns on unsaved changes
- [x] 9a.5 Menus, bars and grids: favourites and recent pages in the sidebar; a status bar (company, year,
      connection and outbox, version, new release); data grids with column choice, resize, reorder, freeze, density,
      saved views and Excel export, remembered per person
- [x] 9a.6 Charts: one style across dashboards (colour-blind-safe palette, legends, units, full-figure tooltips), a
      table view of every chart, drill-down
- [x] 9a.7 Process flows: the stage strip on documents that move (requisition to payment, measurement to receipt,
      booking to possession) with links to the documents before and after
- [x] 9a.8 Accessibility: keyboard reach, focus order and visible focus, labels; an automated check in the browser
      suite
- [x] 9a exit: full check and browser suite
- [x] 9b.1 Settings: one settings area (profile, password and two-factor, notifications, language, theme, formats;
      company settings for admins)
- [x] 9b.2 Help: per-screen help, a searchable help centre, keyboard shortcuts, what's new, a support request with
      diagnostics
- [x] 9b.3 Legal pages: privacy policy, terms of service, terms and conditions, licence terms (drafts, marked for a
      lawyer's review); accepted at first sign-in, versioned, with who accepted which version and when
- [x] 9b.4 Updates: a signed release manifest the installation checks; automatic or manual updates in settings; the
      desktop app installs on restart; a new-release notice in the status bar and on the sign-in screen
- [x] 9b.5 Hardening: headers and content security policy reviewed, rate limits, dependency audit in CI, structured
      logs with request IDs, health and readiness, connection limits, load test, backup restore drill
- [x] 9b.6 Release engineering: version numbers, changelog, signed installers, release checklist
- [ ] 9b exit and Wave 9 exit: full check, browser suite, demo reseed and crawl; report to the owner
