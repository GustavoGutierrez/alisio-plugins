test("opens", async ({ page }) => {
  await page.locator("div > span:nth-child(2)").click();
  await expect(page).toHaveTitle("x");
});
