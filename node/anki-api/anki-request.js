export async function callAnki(action, params = undefined) {
  try {
    const response = await fetch(process.env.ANKI_URL, {
      method: "POST",
      body: JSON.stringify({ action: action, version: 6, params }),
    });

    if (!response.ok) {
      throw new Error(`Response status: ${response.status}`);
    }

    const result = await response.json();
    return result;
  } catch (err) {
    throw err;
  }
}
