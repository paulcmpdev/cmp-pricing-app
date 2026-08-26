import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authOptions } from "../auth-options";

const env = process.env as Record<string, string | undefined>;
const original = {
  CMP_ALLOWED_GOOGLE_DOMAIN: env.CMP_ALLOWED_GOOGLE_DOMAIN,
  CMP_ADMIN_EMAILS: env.CMP_ADMIN_EMAILS,
  CMP_MANAGER_EMAILS: env.CMP_MANAGER_EMAILS,
};

const callbacks = authOptions.callbacks!;

beforeEach(() => {
  env.CMP_ALLOWED_GOOGLE_DOMAIN = "cmpsportswear.com";
  env.CMP_ADMIN_EMAILS = "paul@cmpsportswear.com";
  env.CMP_MANAGER_EMAILS = "manager@cmpsportswear.com";
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
});

describe("NextAuth Google callbacks", () => {
  it("accepts only verified identities in the exact CMP domain", async () => {
    const signIn = callbacks.signIn!;

    await expect(
      signIn({
        profile: {
          email: "rep@cmpsportswear.com",
          email_verified: true,
        },
      } as never)
    ).resolves.toBe(true);

    for (const profile of [
      { email: "rep@cmpsportswear.com", email_verified: false },
      { email: "rep@sub.cmpsportswear.com", email_verified: true },
      { email: "rep@gmail.com", email_verified: true },
      { email_verified: true },
    ]) {
      await expect(signIn({ profile } as never)).resolves.toBe(false);
    }
  });

  it("fails closed when the allowed domain is missing", async () => {
    delete env.CMP_ALLOWED_GOOGLE_DOMAIN;

    await expect(
      callbacks.signIn!({
        profile: {
          email: "paul@cmpsportswear.com",
          email_verified: true,
        },
      } as never)
    ).resolves.toBe(false);
  });

  it("normalizes Google email and derives Admin precedence into the JWT", async () => {
    env.CMP_MANAGER_EMAILS =
      "paul@cmpsportswear.com,manager@cmpsportswear.com";

    const token = await callbacks.jwt!({
      token: {},
      profile: {
        email: "  PAUL@CMPSPORTSWEAR.COM  ",
        name: "Paul Sanford",
        picture: "https://example.invalid/paul.png",
      },
    } as never);

    expect(token).toMatchObject({
      email: "paul@cmpsportswear.com",
      role: "admin",
      name: "Paul Sanford",
      picture: "https://example.invalid/paul.png",
    });
  });

  it("derives Sales Rep by default and exposes the server role in session", async () => {
    const token = await callbacks.jwt!({
      token: {},
      profile: {
        email: "rep@cmpsportswear.com",
        name: "CMP Rep",
      },
    } as never);

    expect(token.role).toBe("sales_rep");

    const session = await callbacks.session!({
      session: { user: {} },
      token,
    } as never);

    expect(session.user).toMatchObject({
      email: "rep@cmpsportswear.com",
      name: "CMP Rep",
      role: "sales_rep",
    });
  });
});
