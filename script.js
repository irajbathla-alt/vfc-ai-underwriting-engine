const APPS_SCRIPT_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxLCt_MKvRoiVGwB7CONfRVBauJ-dO79xK_J-LBI0FGdvc5fpWSO4t927oxLZ8xvig/exec";

const form = document.getElementById("applicationForm");
const statusMessage = document.getElementById("statusMessage");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const files = Array.from(formData.getAll("documents") || []).filter(file => file && file.name);
  const applicationId = generateApplicationId();

  const payload = {
    applicationId,
    businessName: formData.get("businessName"),
    ownerName: formData.get("ownerName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    industry: formData.get("industry"),
    timeInBusiness: formData.get("timeInBusiness"),
    creditScore: Number(formData.get("creditScore")),
    monthlySalesEstimate: Number(formData.get("monthlySalesEstimate")),
    consent: formData.get("consent") === "on"
  };

  try {
    setStatus("Creating application record...");
    await postToAppsScript({ action: "submitApplication", payload });

    if (files.length) {
      setStatus(`Uploading ${files.length} document${files.length > 1 ? "s" : ""}...`);
      for (const file of files) {
        const base64Data = await fileToBase64(file);
        await postToAppsScript({
          action: "uploadDocument",
          payload: {
            applicationId,
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            base64Data
          }
        });
      }
    }

    setStatus(`Application submitted successfully. Reference ID: ${applicationId}`);
    form.reset();
  } catch (error) {
    console.error(error);
    setStatus("There was an issue submitting the application. Please try again.");
  }
});

function postToAppsScript(body) {
  return fetch(APPS_SCRIPT_WEB_APP_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function generateApplicationId() {
  return "APP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function setStatus(message) {
  if (statusMessage) statusMessage.textContent = message;
}
