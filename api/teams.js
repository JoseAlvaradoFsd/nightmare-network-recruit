export default async function handler(req, res) {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username required' });

  try {
    // Get OAuth token
    const tokenRes = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
      { method: 'POST' }
    );
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;
    if (!token) throw new Error('Could not get Twitch token');

    // Get broadcaster ID from username
    const userRes = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`,
      { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } }
    );
    const userData = await userRes.json();
    const broadcaster = userData.data?.[0];
    if (!broadcaster) return res.status(404).json({ error: 'Twitch user not found' });

    // Get teams for that broadcaster
    const teamsRes = await fetch(
      `https://api.twitch.tv/helix/teams/channel?broadcaster_id=${broadcaster.id}`,
      { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } }
    );
    const teamsData = await teamsRes.json();

    return res.status(200).json({
      teams: teamsData.data || [],
      broadcasterName: broadcaster.display_name
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
