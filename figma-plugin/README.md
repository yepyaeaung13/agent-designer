# Figma → Agent Designer → coding agent

This local development plugin exports the selected frame into an `.agentdesign.json` file. It makes no REST API requests and asks for no token. Figma itself must have loaded the design and its images.

1. In Figma desktop, use **Plugins → Development → Import plugin from manifest** and choose this folder's `manifest.json`. If Figma requests a plugin ID, create a new development plugin first and copy its assigned `id` into this manifest.
2. Open your design, select one frame, and run **Agent Designer Export**.
3. Click **Export selected frame**, then **Save export**. Keep the design unchanged while exporting.
4. Start/restart Agent Designer and click **Import export file**. Select the saved JSON file.
5. Check **Reference & notes**. Connect your coding agent using **Connect agent**, then use **Copy coding prompt** for the imported frame.

The bundle contains the original Figma node properties, component/style metadata returned by Figma, source images, rendered complex layers, and a reference PNG. These are stored locally in SQLite and exposed through the existing MCP context, preview, and asset tools. File import is atomic; invalid or incomplete bundles create no document. Canceling the file picker changes nothing.

Limits: 2,000 layers, nesting depth 64, 80 complex layers, 80 source images, 12 MB per image and 64 MB total image data. Rendered layers and previews are PNG, downscaled to at most 4096 pixels on their longest dimension. This first exporter preserves vector properties in the source data but renders complex layers as PNG. Fonts are not included; canvas approximations are listed in Reference & notes. File provenance may omit the Figma file key when Figma does not expose it to a development plugin.

No build step or dependency installation is needed for this plugin. Plugin behavior is tested against a simulated Figma API; installation and export should also be checked in your Figma desktop app.

For later changes, export the same frame again and choose **Update from export** in its existing Agent Designer document. Review conflicts before applying. Existing source layer IDs are retained, local edits are preserved by default, and the update can be undone during the current app session. If the plugin cannot supply a file key, the app asks you to confirm that the new export came from the same Figma file.

The app now normalizes child sizing, layout positioning, constraints and available min/max dimensions from the existing REST-shaped export. No format change is required. Existing app documents can recover missing details using the explicit undoable action; current edits are preserved.
