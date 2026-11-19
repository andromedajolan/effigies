# Effigies data format

Effigies is part of the Abditum studio suite. This file documents what it stores and exchanges.

## Storage keys (all prefixed `effigies`)

| Where | Key | Content |
|---|---|---|
| localStorage | `effigies.prefs` | JSON preferences |
| localStorage | `studio.theme` | `"dark"` or `"gray"` (**shared** with the suite; `"light"` is read as gray) |
| IndexedDB | `effigies-db` | stores `docs`, `blobs`, `meta` (autosave and open-tab session) |
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
  "type": "raster | group",
  "name": "string",
  "visible": true,
  "opacity": 1,
  "fill": 1,
  "blend": "normal",
  "lock": { "transparentPixels": false, "imagePixels": false, "position": false, "all": false },
  "x": 0, "y": 0, "width": 0, "height": 0,
  "image": "data:image/png;base64,... or null",
  "collapsed": false,
  "children": []
}
```

- `image` is the layer's pixel rectangle at offset (`x`, `y`) in document space; `null` when empty. Groups have no `image`, but have `children` (bottom to top) and `collapsed`.
- `blend` is one of 27 mode ids (normal, dissolve, darken, multiply, colorBurn, linearBurn, darkerColor, lighten, screen, colorDodge, linearDodge, lighterColor, overlay, softLight, hardLight, vividLight, linearLight, pinLight, hardMix, difference, exclusion, subtract, divide, hue, saturation, color, luminosity).

## Versioning rules

- `version` is an integer. Additive changes (new optional fields) keep the version. Breaking changes bump it.
- Importers must ignore unknown fields and refuse a newer `version` with a clear message.
- Later stages add optional layer fields (masks, styles, adjustments, text) without bumping the version.

## Size note

Layers are PNG data URLs, so a project with many full-size layers is large (about 186 MB for 20 layers at 3000 x 3000).
