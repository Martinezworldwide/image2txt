// app.js
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const browseBtn = document.getElementById("browseBtn");

const out = document.getElementById("out");
const statusText = document.getElementById("statusText");
const fileCount = document.getElementById("fileCount");
const bar = document.getElementById("bar");

const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");
const clearBtn = document.getElementById("clearBtn");

const langSel = document.getElementById("lang");
const psmSel = document.getElementById("psm");

let busy = false;

function setStatus(text) {
  statusText.textContent = text;
}

function setProgress(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  bar.style.width = `${clamped}%`;
}

function appendOutput(text) {
  if (!text) return;
  const separator = out.value.trim().length ? "\n\n---\n\n" : "";
  out.value += separator + text.trim();
}

function getPSMConfig() {
  // Tesseract.js supports config variables; "tessedit_pageseg_mode" controls layout handling.
  // Values are numeric in core tesseract, but tesseract.js accepts strings for some wrappers.
  // We'll use safe defaults by mapping our menu to common numeric modes.
  // 3 = AUTO, 6 = SINGLE_BLOCK, 7 = SINGLE_LINE
  const choice = psmSel.value;
  if (choice === "SINGLE_BLOCK") return { tessedit_pageseg_mode: "6" };
  if (choice === "SINGLE_LINE") return { tessedit_pageseg_mode: "7" };
  return { tessedit_pageseg_mode: "3" }; // AUTO
}

async function ocrFile(file, index, total) {
  const lang = langSel.value;
  setStatus(`Recognizing (${index + 1}/${total}): ${file.name}`);

  const { data } = await Tesseract.recognize(file, lang, {
    logger: (m) => {
      // m.progress is 0..1 for some stages
      if (typeof m.progress === "number") {
        // overall-ish progress: allocate by file index
        const perFile = 100 / total;
        const base = perFile * index;
        const pct = base + perFile * (m.progress * 100) / 100;
        setProgress(pct);
      }
    },
    // config variables
    // Note: Tesseract.js v5 supports passing "config" as 4th param in some patterns,
    // but it also accepts it inside options in many builds.
  }).catch((err) => {
    console.error(err);
    appendOutput(`[Error reading ${file.name}]`);
    return null;
  });

  return data?.text || "";
}

async function handleFiles(files) {
  if (busy) return;
  const list = Array.from(files || []).filter(f => f.type.startsWith("image/"));
  if (!list.length) {
    setStatus("No image files detected.");
    return;
  }

  busy = true;
  fileCount.textContent = `${list.length} file(s)`;
  setProgress(0);
  setStatus("Starting OCR...");

  // Apply PSM config (best effort)
  const psmConfig = getPSMConfig();
  // Tesseract.js exposes a global worker API too, but recognize() is simplest for GitHub Pages.
  // We’ll set config by temporarily patching recognize via "Tesseract.setLogging" is not for config.
  // So: we pass config using "Tesseract.recognize(image, lang, { ... , tessedit_pageseg_mode })"
  // Many builds pass unknown keys to the engine; we include it.
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const { data } = await Tesseract.recognize(file, langSel.value, {
      ...psmConfig,
      logger: (m) => {
        if (typeof m.progress === "number") {
          const perFile = 100 / list.length;
          const base = perFile * i;
          const pct = base + perFile * m.progress;
          setProgress(pct);
        }
      },
    }).catch((err) => {
      console.error(err);
      appendOutput(`[Error reading ${file.name}]`);
      return { data: { text: "" } };
    });

    const text = data?.text || "";
    const header = `FILE: ${file.name}\n`;
    appendOutput(header + text);
  }

  setProgress(100);
  setStatus("Done.");
  busy = false;
}

function prevent(e) {
  e.preventDefault();
  e.stopPropagation();
}

// Drag/drop events
["dragenter", "dragover"].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    prevent(e);
    dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    prevent(e);
    dropzone.classList.remove("dragover");
  });
});
dropzone.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  handleFiles(files);
});

// Click to browse
browseBtn.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => handleFiles(fileInput.files));

// Paste image from clipboard
window.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  const files = [];
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) handleFiles(files);
});

// Buttons
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(out.value);
    setStatus("Copied to clipboard.");
  } catch {
    setStatus("Copy failed (browser permission).");
  }
});

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([out.value || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ocr-output.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

clearBtn.addEventListener("click", () => {
  out.value = "";
  setProgress(0);
  fileCount.textContent = "";
  setStatus("Idle");
});
