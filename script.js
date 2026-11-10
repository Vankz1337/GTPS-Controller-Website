const button = document.querySelector("#check-button");
const statusText = document.querySelector("#status-text");

button.addEventListener("click", () => {
  statusText.textContent = "Interface check completed.";
  button.textContent = "Checked";
});
