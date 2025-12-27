// app.js

// ---------- UI ----------
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
const preprocessSel = document.getElementById("preprocess");
const quizDetectSel = document.getElementById("quizDetect");

const answerText = document.getElementById("answerText");
const answerWhy = document.getElementById("answerWhy");

let busy = false;

// ---------- Helpers ----------
function setStatus(text) {
  statusText.textContent = text;
}
function setProgress(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  bar.style.width = `${clamped}%`;
}
function setAnswer(ans, why) {
  if (!ans) {
    answerText.textContent = "—";
    answerText.classList.add("muted");
    answerWhy.textContent = "";
    answerWhy.classList.add("muted");
    return;
  }
  answerText.textContent = ans;
  answerText.classList.remove("muted");
  answerWhy.textContent = why || "";
  answerWhy.classList.remove("muted");
}
function appendOutput(text) {
  if (!text) return;
  const separator = out.value.trim().length ? "\n\n---\n\n" : "";
  out.value += separator + text.trim();
}
function prevent(e) {
  e.preventDefault();
  e.stopPropagation();
}

// ---------- Image preprocessing (big accuracy boost for screenshots) ----------
async function fileToImageBitmap(file) {
  const blobURL = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = blobURL;
    });
    // ImageBitmap gives better draw performance when available
    if ("createImageBitmap" in window) {
      return await createImageBitmap(img);
    }
    return img;
  } finally {
    URL.revokeObjectURL(blobURL);
  }
}

/**
 * Convert ImageBitmap or Image to dataURL for Tesseract (must be serializable)
 */
async function imageToDataURL(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Preprocess screenshot to help OCR:
 * - upscale 2x
 * - grayscale
 * - contrast boost
 * - binarize (threshold)
 * Returns a dataURL (PNG) for OCR.
 */
async function preprocessImageForOCR(file) {
  const img = await fileToImageBitmap(file);

  const scale = 2.0; // 2x upscale helps small UI text a lot
  const w = Math.floor(img.width * scale);
  const h = Math.floor(img.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Draw upscaled
  ctx.drawImage(img, 0, 0, w, h);

  // Pixel ops
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Tuned for screenshots: slight contrast + threshold
  const contrast = 1.25; // >1 increases contrast
  const threshold = 175; // binarize cutoff

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];

    // grayscale (luma)
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // contrast around mid-point 128
    y = (y - 128) * contrast + 128;

    // binarize
    const v = y >= threshold ? 255 : 0;

    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    // alpha unchanged
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

// ---------- OCR cleanup (fix the garbage you saw: ¥, ©, fake radio circles, etc.) ----------
function cleanOCRText(raw) {
  if (!raw) return "";

  let t = raw;

  // Normalize weird characters that show up in UI screenshots
  t = t.replace(/[¥©®™]/g, "");              // remove common junk symbols
  t = t.replace(/[•·]/g, "-");               // normalize bullets

  // Remove fake radio-button circles often recognized as "O" at line starts
  // Examples: "O static" -> "static"
  t = t.replace(/^\s*[O0○◯]\s+/gm, "");

  // Sometimes OCR produces "© Anonymous" etc.
  t = t.replace(/^\s*[©]\s+/gm, "");

  // Remove isolated lines that are only junk
  t = t.replace(/^\s*[$¥©]+?\s*$/gm, "");

  // Fix common brace/indent issues lightly
  t = t.replace(/\r/g, "");
  t = t.replace(/[ \t]+\n/g, "\n");          // trailing whitespace
  t = t.replace(/\n{3,}/g, "\n\n");          // collapse huge gaps

  // Fix "}" lines sometimes duplicated as weird chars
  t = t.replace(/^[^\S\n]*[|\\\/]{1,}[^\S\n]*$/gm, "");

  return t.trim();
}

// ---------- Quiz answer detection (rule-based, no hallucinating) ----------
function detectQuizAnswer(cleanedText) {
  // If user turned it off
  if (quizDetectSel.value !== "on") return null;

  const text = cleanedText.toLowerCase();

  // Must look like a question
  const hasQuestion = cleanedText.includes("?") || /what\b.*\b(type|kind)\b/.test(text);
  if (!hasQuestion) return null;

  // Extract choices if they exist (we look for common MCQ words)
  // NOTE: this is intentionally conservative
  const possibleChoices = extractChoices(cleanedText);

  // ---- Java-specific pattern: local class inside a method ----
  // Example:
  // public void printLabel() { class ProductCode {} ... }
  const localClassPattern =
    /public\s+void\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\bclass\s+\w+\b[\s\S]*?\}/i.test(cleanedText) &&
    /\bclass\s+\w+\b\s*\{\s*\}/i.test(cleanedText);

  if (localClassPattern) {
    const answer = pickChoice(possibleChoices, ["local"]);
    return {
      answer: answer || "Local",
      why: "The class is declared inside a method body, which makes it a local (method-local) class in Java."
    };
  }

  // ---- Java-specific: anonymous class pattern ----
  // new InterfaceOrClass() { ... }
  const anonymousPattern = /\bnew\s+\w+\s*\([^)]*\)\s*\{\s*[\s\S]*?\}/i.test(cleanedText);
  if (anonymousPattern) {
    const answer = pickChoice(possibleChoices, ["anonymous"]);
    return {
      answer: answer || "Anonymous",
      why: "An anonymous class is created with `new Type(){ ... }` (a class body with no declared class name)."
    };
  }

  // ---- Java-specific: static nested class pattern ----
  const staticNestedPattern = /\bstatic\s+class\s+\w+\b/i.test(cleanedText);
  if (staticNestedPattern) {
    const answer = pickChoice(possibleChoices, ["static"]);
    return {
      answer: answer || "Static",
      why: "A static nested class is declared with `static class Name { ... }`."
    };
  }

  // If we can’t be sure, return null (don’t guess)
  return null;
}

function extractChoices(cleanedText) {
  // Grab short lines that look like options.
  // We also scan the entire text for common option words.
  const lines = cleanedText.split("\n").map(l => l.trim()).filter(Boolean);

  // Filter out code-like lines
  const optionish = lines.filter(l => {
    const lower = l.toLowerCase();
    if (lower.includes("{") || lower.includes("}") || lower.includes(";")) return false;
    if (lower.startsWith("class ")) return false;
    if (lower.startsWith("public ")) return false;
    if (lower.length > 40) return false; // options usually short
    return true;
  });

  // If OCR kept them on one line, attempt to pull known words
  const known = [];
  const knownWords = ["static", "local", "anonymous", "shadow", "private", "public", "protected"];
  for (const w of knownWords) {
    if (cleanedText.toLowerCase().includes(w)) known.push(w);
  }

  // Merge: keep unique
  const all = [...optionish, ...known];
  const uniq = [];
  for (const x of all) {
    const norm = x.toLowerCase();
    if (!uniq.some(u => u.toLowerCase() === norm)) uniq.push(x);
  }

  return uniq;
}

function pickChoice(choices, keywords) {
  if (!choices || !choices.length) return null;
  for (const c of choices) {
    const lc = c.toLowerCase();
    if (keywords.some(k => lc.includes(k))) return normalizeChoice(c);
  }
  return null;
}

function normalizeChoice(c) {
  // Capitalize first letter if it’s one word
  const trimmed = (c || "").trim();
  if (!trimmed) return trimmed;
  if (/^[a-z]+$/i.test(trimmed)) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  return trimmed;
}

// ---------- Tesseract worker (reuse one worker for speed) ----------
let worker = null;

async function getWorker(lang) {
  if (!worker) {
    worker = await Tesseract.createWorker({
      logger: (m) => {
        if (typeof m.progress === "number") {
          // this is per-image; we handle overall progress outside
          // leaving here avoids double updates
        }
      }
    });
  }
  // load language each time user changes
  await worker.loadLanguage(lang);
  await worker.initialize(lang);
  return worker;
}

async function recognizeImage(source, lang, psm, onProgress) {
  const w = await getWorker(lang);
  // PSM: set page segmentation mode
  await w.setParameters({
    tessedit_pageseg_mode: String(psm)
  });

  const result = await w.recognize(source, {
    logger: (m) => {
      if (typeof m.progress === "number") onProgress(m.progress);
    }
  });

  return result?.data?.text || "";
}

// ---------- File processing ----------
async function processFiles(files) {
  if (busy) {
    setStatus("Already processing, please wait...");
    return;
  }

  // Filter to images only
  const imageFiles = Array.from(files).filter(f => f.type.startsWith("image/"));
  if (imageFiles.length === 0) {
    setStatus("No image files found");
    return;
  }

  busy = true;
  setStatus(`Processing ${imageFiles.length} image(s)...`);
  setProgress(0);
  fileCount.textContent = `${imageFiles.length} file(s)`;

  try {
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const progressPerFile = 100 / imageFiles.length;
      const baseProgress = i * progressPerFile;

      setStatus(`Processing ${i + 1}/${imageFiles.length}: ${file.name}`);

      // Preprocess if enabled, otherwise convert to dataURL (required for Tesseract worker)
      let source;
      if (preprocessSel.value === "on") {
        source = await preprocessImageForOCR(file);
      } else {
        // Convert ImageBitmap/Image to dataURL so it can be cloned for the worker
        const img = await fileToImageBitmap(file);
        source = await imageToDataURL(img);
      }

      // Run OCR
      const rawText = await recognizeImage(
        source,
        langSel.value,
        parseInt(psmSel.value),
        (pct) => {
          // Update progress: base progress + this file's progress
          setProgress(baseProgress + (pct * progressPerFile / 100));
        }
      );

      // Clean up OCR text
      const cleanedText = cleanOCRText(rawText);
      appendOutput(cleanedText);

      // Detect quiz answer if enabled
      const answer = detectQuizAnswer(cleanedText);
      if (answer) {
        setAnswer(answer.answer, answer.why);
      }

      setProgress((i + 1) * progressPerFile);
    }

    setStatus(`Done! Processed ${imageFiles.length} image(s)`);
  } catch (err) {
    console.error("Error processing files:", err);
    setStatus(`Error: ${err.message}`);
    appendOutput(`\n\n[Error processing: ${err.message}]`);
  } finally {
    busy = false;
  }
}

// ---------- Event handlers ----------
// Handle file input change
fileInput.addEventListener("change", (e) => {
  if (e.target.files && e.target.files.length > 0) {
    processFiles(e.target.files);
  }
});

// Handle browse button click
browseBtn.addEventListener("click", () => {
  fileInput.click();
});

// Handle drag and drop
dropzone.addEventListener("dragover", (e) => {
  prevent(e);
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", (e) => {
  prevent(e);
  dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", (e) => {
  prevent(e);
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    processFiles(e.dataTransfer.files);
  }
});

// Handle paste event
document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  const imageFiles = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        imageFiles.push(file);
      }
    }
  }

  if (imageFiles.length > 0) {
    prevent(e);
    processFiles(imageFiles);
  }
});

// Handle copy button
copyBtn.addEventListener("click", async () => {
  if (!out.value.trim()) {
    setStatus("Nothing to copy");
    return;
  }
  try {
    await navigator.clipboard.writeText(out.value);
    setStatus("Copied to clipboard!");
  } catch (err) {
    console.error("Copy failed:", err);
    setStatus("Copy failed");
  }
});

// Handle download button
downloadBtn.addEventListener("click", () => {
  if (!out.value.trim()) {
    setStatus("Nothing to download");
    return;
  }
  const blob = new Blob([out.value], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ocr-output.txt";
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Downloaded!");
});

// Handle clear button
clearBtn.addEventListener("click", () => {
  out.value = "";
  setAnswer(null);
  setStatus("Cleared");
  setProgress(0);
  fileCount.textContent = "";
});

// Handle dropzone click (focus for keyboard)
dropzone.addEventListener("click", (e) => {
  // Only trigger file input if clicking directly on dropzone, not on buttons
  if (e.target === dropzone || e.target.closest(".dropzone-inner")) {
    fileInput.click();
  }
});
