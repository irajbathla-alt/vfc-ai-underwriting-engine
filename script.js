const APPS_SCRIPT_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbw2_3zoG4jexxDf-4C4THEN5aQ3OTP9kXhOFINj_yEYlsF5J0UA0Hxialjy6ZNfsg/exec";
const MINIMUM_STATEMENT_FILES = 6;

const form = document.getElementById("applicationForm");
const statusMessage = document.getElementById("statusMessage");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const files = Array.from(formData.getAll("documents") || []).filter(file => file && file.name);

  if (files.length < MINIMUM_STATEMENT_FILES) {
    setStatus(`Please upload at least ${MINIMUM_STATEMENT_FILES} months of bank statements before submitting.`);
    return;
  }

  const applicationId = generateApplicationId();
  const businessName = String(formData.get("businessName") || "").trim();
  const ownerName = String(formData.get("ownerName") || "").trim();

  const payload = {
    applicationId,
    businessName,
    ownerName,
    email: formData.get("email"),
    phone: formData.get("phone"),
    industry: formData.get("industry"),
    timeInBusiness: formData.get("timeInBusiness"),
    creditScore: Number(formData.get("creditScore")),
    monthlySalesEstimate: Number(formData.get("monthlySalesEstimate")),
    statementFileCount: files.length,
    consent: formData.get("consent") === "on"
  };

  try {
    setStatus("Creating application record...");
    await postToAppsScript({ action: "submitApplication", payload });

    setStatus(`Uploading ${files.length} statement file${files.length > 1 ? "s" : ""} into ${ownerName} - ${businessName} folder...`);
    for (const file of files) {
      const base64Data = await fileToBase64(file);
      await postToAppsScript({
        action: "uploadDocument",
        payload: {
          applicationId,
          businessName,
          ownerName,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          base64Data
        }
      });
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
