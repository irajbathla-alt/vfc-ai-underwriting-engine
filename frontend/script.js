const APPS_SCRIPT_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxHRHUXY0F-qmN8Dl9KSbp5hb8Eji0c88JrHB7plavdwtK0ZbBaMc5x9wjjZ9D3hF4/exec";

const form = document.getElementById("applicationForm");
const statusMessage = document.getElementById("statusMessage");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusMessage.textContent = "Submitting application...";

  const formData = new FormData(form);
  const payload = {
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
    const response = await fetch(APPS_SCRIPT_WEB_APP_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submitApplication", payload })
    });

    statusMessage.textContent = "Application submitted. Our team will review it shortly.";
    form.reset();
  } catch (error) {
    console.error(error);
    statusMessage.textContent = "There was an issue submitting the application.";
  }
});
