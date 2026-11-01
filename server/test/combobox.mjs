// Drive the Combobox the way a person does: tap the field, then tap the option with that value.
export const pickOption = async (input, value) => {
  await input.click();
  await input.locator('xpath=ancestor::div[contains(@class,"cb")][1]').locator(`[role="option"][data-value="${value}"]`).click();
};
