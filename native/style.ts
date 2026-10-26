// The look of the menus and HUD: the browser build's style sheet
// (tools/ui-style.css, converted once with `starhermit css` into
// assets/ui-style.json by `npm run css`) registered as starhermit:ui styles,
// plus what the sheet had no selector for: the theme's colours, the dialog
// (the browser's .bb-modal veil + .bb-card), text fields, selects and checkboxes.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export function setStyle(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setTheme({
    fontSize: 16, headingSize: 22, smallSize: 13.6, padding: 8, spacing: 8,
    text: "#f0ead8", muted: "#b8b09a", panel: "#151830", control: "#151830", hovered: "#1d2140",
    pressed: "#242a50", field: "#0d1024", accent: "#d8b25c", focus: "#ffd97a", outline: "#d8b25c", radius: 10,
  });
  const card = css.styles[".card"]!;
  const veil = css.styles[".veil"]!;
  ui.setStyles({
    ...css.styles,
    // A modal card: .bb-card's box over .bb-modal's dim.
    dialog: {
      background: card.background!, radius: card.radius!, shadow: card.shadow!, padding: card.padding!, border: card.border!,
      inside: { heading: { text: { size: 22, weight: "700", color: "$ink" }, margin: { bottom: 4 } } },
      parts: { backdrop: { background: veil.background! } },
    },
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    checkbox: { text: { color: "$ink" }, minHeight: 44, parts: { box: { background: "$field", border: { width: 1, color: "$line" }, radius: 4 }, mark: { background: "$accent" } } },
    select: {
      text: { color: "$ink" },
      parts: {
        field: { background: "$field", radius: 8, padding: { top: 6, end: 10, bottom: 6, start: 10 }, minHeight: 44, border: { width: 1, color: "$line" }, hovered: { border: { color: "$accent" } } },
        list: { background: "$panel-solid", radius: 8, border: { width: 1, color: "$accent" } },
        option: { hovered: { background: "#1d2140" }, selected: { text: { color: "$accent" } } },
      },
    },
    textField: { text: { color: "$ink" }, background: "$field", radius: 8, border: { width: 1, color: "$line" }, padding: { top: 6, end: 10, bottom: 6, start: 10 }, minHeight: 44 },
    scrollArea: { parts: { bar: { background: "$line", radius: 4 } } },
    // The title key art and the results illustrations (the browser's <img> with radius and border).
    ...Object.fromEntries([["art-key", "assets/key-art.webp"], ["art-victory", "assets/results-victory.webp"], ["art-road", "assets/results-road.webp"]]
      .map(([k, image]) => [`.${k}`, { extends: [".art"], background: [{ image: image!, size: "cover" }, "#1a1d33"] } as ui.Style])),
  });
}
