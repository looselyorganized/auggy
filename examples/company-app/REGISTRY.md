# Registry provenance

`src/components/ui/{button,textarea}.tsx` and `src/lib/utils.ts` are copied from
the existing generated Auggy registry consumer in `admin/src/`. The shared theme
is copied unchanged from `admin/src/auggy-theme.css`. No new primitive is introduced.

The reference uses the light theme and existing semantic colors for its support
workflow. App layout styles live in `src/app/globals.css`; authentication states
remain ordinary accessible text and controls. Follow the repository's registry
sync workflow when changing a primitive or shared theme.
