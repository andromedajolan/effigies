# Effigies data format

Effigies is part of the Abditum studio suite. This file documents what it stores and exchanges.

## Storage keys (all prefixed `effigies`)

| Where | Key | Content |
|---|---|---|
| localStorage | `effigies.prefs` | JSON preferences (includes `brushPresets`, your saved brushes) |
| localStorage | `studio.theme` | `"dark"` or `"gray"` (**shared** with the suite; `"light"` is read as gray) |
| IndexedDB | `effigies-db` | stores `docs`, `blobs`, `meta` (autosave and open-tab session; layer and mask pixels are PNG blobs) |
| Cache Storage | `effigies-cache-<version>` | offline app shell |

`studio.theme` is the only key shared with other apps.

## Project file: `*.effigies.json`

```json
{
  "format": "effigies-project",
  "version": 1,
  "app": "Effigies",
  "appVersion": "0.1.0",
  "projectId": "stable id, survives export/import",
  "name": "string",
  "created": "ISO-8601", "modified": "ISO-8601",
  "width": 3000, "height": 3000,
  "colorMode": "RGB", "bitDepth": 8,
  "activeLayerId": "string",
  "songRef": null,
  "layers": [ /* bottom to top */ ]
}
```

- `projectId`: stable identifier other apps can link to.
- `songRef`: optional string or object supplied by another suite app (for example a Sonorum song id). Effigies keeps it untouched.

### Layer

```json
{
  "id": "string",
  "type": "raster | group | adjust",
  "name": "string",
  "visible": true,
  "opacity": 1,
  "fill": 1,
  "blend": "normal",
  "lock": { "transparentPixels": false, "imagePixels": false, "position": false, "all": false },
  "x": 0, "y": 0, "width": 0, "height": 0,
  "image": "data:image/png;base64,... or null",
  "mask": {
    "x": 0, "y": 0, "width": 0, "height": 0,
    "enabled": true,
    "image": "data:image/png;base64,..."
  },
  "clip": false,
  "text": { },
  "styles": { },
  "adjustment": { "id": "levels", "params": { } },
  "collapsed": false,
  "children": []
}
```

- `mask` is optional (raster layers only). Its `image` is a PNG where the **alpha channel is how much of the layer is hidden** (0 = fully shown, 255 = fully hidden); the colour channels are always black. `x`, `y` are relative to the layer's own `x`, `y`, so the mask moves with its layer. Outside the mask rectangle the layer is fully shown. `enabled: false` means the mask is kept but not applied.

- `type: "adjust"` is an adjustment layer: it has no `image`; it changes everything below it (or inside its group if the group is isolated). `adjustment.id` is one of `brightnessContrast, levels, curves, exposure, vibrance, hueSat, colorBalance, blackWhite, photoFilter, channelMixer, gradientMap, invert, desaturate, posterize, threshold`. `adjustment.params` is that adjustment's settings object (plain JSON numbers, booleans, strings and arrays; unknown ids should be kept untouched and shown as a hidden-effect placeholder). `opacity` scales its strength; `fill` and `blend` are not used. It may have a `mask` like a raster layer.
- `clip: true` clips the layer to the nearest layer below it that is not itself clipped (its "base"): the layer is only visible where the base has pixels, and keeps its own blend mode and opacity. Optional; omitted means false. A layer cannot be clipped to an adjustment layer.
- `text` (optional, on a `raster` layer) marks a **type layer**. The layer's `image` is a render of these settings, so other apps can show it without the font. Fields: `content` (string, `\n` for new lines), `family` (one of the bundled Google Fonts, see `fonts/`), `bold`, `italic` (booleans), `size` (px), `color` (`#rrggbb`), `align` (`left|center|right`), `lineHeight` (multiplier), `tracking` (thousandths of an em), `boxW` (px, or null for point text), `ox`, `oy` (where the text anchor, the first baseline at its alignment point, sits inside `image`; the anchor in the document is `x + ox`, `y + oy`). Painting on the layer removes `text` and keeps the pixels.
- `styles` (optional, any non-group layer) holds layer styles keyed by effect: `dropShadow`, `outerGlow`, `innerShadow`, `innerGlow`, `bevel`, `colorOverlay`, `gradientOverlay`, `stroke`. Each has `on` plus its own settings (colours as `#rrggbb`, sizes in document px, opacities 0-100, angles in degrees, blend ids as in `blend`). Effects are drawn at render time, outside `image`; `image` itself never contains them.
- `image` is the layer's pixel rectangle at offset (`x`, `y`) in document space; `null` when empty. Groups have no `image`, but have `children` (bottom to top) and `collapsed`.
- `blend` is one of 27 mode ids (normal, dissolve, darken, multiply, colorBurn, linearBurn, darkerColor, lighten, screen, colorDodge, linearDodge, lighterColor, overlay, softLight, hardLight, vividLight, linearLight, pinLight, hardMix, difference, exclusion, subtract, divide, hue, saturation, color, luminosity).

## Versioning rules

- `version` is an integer. Additive changes (new optional fields) keep the version. Breaking changes bump it.
- Importers must ignore unknown fields and refuse a newer `version` with a clear message.
- Stage 2 added the optional `mask` field (still version 1). Stage 3A added `type: "adjust"`, `adjustment` and `clip`, and stage 3B added `text` and `styles` (all still version 1). Later stages add further optional layer fields (styles, adjustments, text) the same way.

## Size note

Layers are PNG data URLs, so a project with many full-size layers is large (about 186 MB for 20 layers at 3000 x 3000).
