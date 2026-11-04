const token = process.env.WHATSAPP_ACCESS_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const version = process.env.WHATSAPP_API_VERSION;

if (!token || !phoneNumberId || !version) {
  console.error('Fill WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_API_VERSION in the local .env file.');
  process.exit(1);
}

try {
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}?fields=id`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await response.json();
  if (!response.ok) {
    const code = result?.error?.code ?? response.status;
    console.error(`Meta credential check failed (${code}). Check the token, phone number ID, and API version in .env.`);
    process.exitCode = 1;
  } else {
    console.log('Meta accepted the access token and phone number ID.');
  }
} catch {
  console.error('Could not reach Meta. Check network access and try again.');
  process.exitCode = 1;
}
