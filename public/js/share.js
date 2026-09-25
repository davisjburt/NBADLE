// public/js/share.js
// Builds the spoiler-free emoji summary of a game and shares or copies it.

const EMOJI = { match: "🟩", partial: "🟨", nomatch: "⬛" };

// rows: comparison rows in the order they were guessed; cols: column keys
export function emojiGrid(rows, cols) {
  const keys = cols.filter((c) => c !== "name");
  return rows
    .map((row) => keys.map((k) => EMOJI[row.cells[k]?.status] || EMOJI.nomatch).join(""))
    .join("\n");
}

export function shareText({ mode, rows, cols, won, guesses, max, url }) {
  const label = mode === "stats" ? "Stats" : "Classic";
  const score = won ? `${guesses}/${max}` : `X/${max}`;
  return `NBADLE ${label} ${score}\n\n${emojiGrid(rows, cols)}\n\n${url}`;
}

// Resolves "shared", "copied", "cancelled" or "failed".
export async function shareResult(text) {
  const touch = navigator.maxTouchPoints > 0;
  if (touch && navigator.share) {
    try {
      await navigator.share({ text });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      // Fall through to copying
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return legacyCopy(text) ? "copied" : "failed";
  }
}

function legacyCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
