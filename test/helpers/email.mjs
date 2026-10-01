// Verified accounts for tests whose subject is unrelated to email delivery.
export async function verifiedUser(auth, name, password = 'correct horse') {
  const user = await auth.register(name, password);
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
