// Certified, email-bound fixture accounts. Level-zero tests use auth.register directly.
export async function verifiedUser(auth, name, password = 'correct horse') {
  const user = await auth.register(name, password);
  auth.promote(name, 1);
  return auth.bindEmail(user.id, `${name}@example.test`);
}

export function captureMailer() {
  const messages = [];
  return {
    mailer: {
      ready: () => true,
      send: async (message) => { messages.push(message); },
    },
    lastCode: (email, purpose) => messages.findLast(message => message.to === email && message.purpose === purpose)?.code,
  };
}
