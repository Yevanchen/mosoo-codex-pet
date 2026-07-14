const input = document.querySelector("#avatar");
const form = document.querySelector("#pet-form");
const dropZone = document.querySelector("#drop-zone");
const submit = document.querySelector("#submit");
const preview = document.querySelector("#preview");
const uploadIcon = document.querySelector("#upload-icon");
const dropTitle = document.querySelector("#drop-title");
const dropCopy = document.querySelector("#drop-copy");
const progress = document.querySelector("#progress");
const result = document.querySelector("#result");
const errorBox = document.querySelector("#error");
const meter = document.querySelector("#meter-fill");
const statusTitle = document.querySelector("#status-title");
const statusCopy = document.querySelector("#status-copy");
const download = document.querySelector("#download");

let selectedFile = null;
let previewUrl = null;
const states = [
  ["queued", 12, "Getting your pet ready", "Mosoo has queued the generation run…"],
  ["booting", 24, "Warming up the studio", "Loading the pet skill and image tools…"],
  ["running", 62, "Picturing every pose", "Generating and checking all nine animation states…"],
  ["waiting_input", 62, "The agent needs attention", "Open the Mosoo run to answer its request."],
];

dropZone.addEventListener("click", () => input.click());
input.addEventListener("change", () => chooseFile(input.files?.[0]));
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-over");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-over");
  });
}
dropZone.addEventListener("drop", (event) => chooseFile(event.dataTransfer?.files?.[0]));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;
  clearError();
  form.hidden = true;
  progress.hidden = false;
  updateStatus("queued");

  try {
    const body = new FormData();
    body.set("file", selectedFile, selectedFile.name);
    const response = await fetch("/api/pets", { body, method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Pet generation could not start.");
    await poll(payload.threadId);
  } catch (error) {
    progress.hidden = true;
    form.hidden = false;
    showError(error instanceof Error ? error.message : "Something went wrong.");
  }
});

function chooseFile(file) {
  clearError();
  if (!file) return;
  if (!file.type.startsWith("image/")) return showError("Choose a PNG, JPEG or WebP image.");
  if (file.size > 10 * 1024 * 1024) return showError("The avatar must be 10 MB or smaller.");
  selectedFile = file;
  submit.disabled = false;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  preview.style.display = "block";
  uploadIcon.style.display = "none";
  dropTitle.textContent = file.name;
  dropCopy.textContent = "Click or drop another image to replace it";
}

async function poll(threadId) {
  for (;;) {
    await delay(2500);
    const response = await fetch(`/api/pets/${encodeURIComponent(threadId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Generation status is unavailable.");
    if (payload.status === "completed" && payload.downloadUrl) {
      meter.style.width = "100%";
      progress.hidden = true;
      result.hidden = false;
      download.href = payload.downloadUrl;
      return;
    }
    if (["cancelled", "expired", "failed"].includes(payload.status)) {
      throw new Error(payload.error ?? `The Mosoo run ${payload.status}.`);
    }
    updateStatus(payload.status);
  }
}

function updateStatus(status) {
  const state = states.find(([name]) => name === status) ?? states[2];
  meter.style.width = `${state[1]}%`;
  statusTitle.textContent = state[2];
  statusCopy.textContent = state[3];
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}
function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
