// Deliberately planted FAKE credential: codediag's security analyzer must flag line 5.
// It is not a real key for any service.
export const appConfig = {
  port: Number(process.env.PORT ?? 3000),
  apiKey: "cdg_fake_4f9a8c2e7b1d6a3f0e5c9b8a",
};
