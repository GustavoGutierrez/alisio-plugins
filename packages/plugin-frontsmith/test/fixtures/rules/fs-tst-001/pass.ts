test("opens", async ({ page }) => {
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveTitle("x");
});
