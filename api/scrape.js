module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'No username provided' });

  const CLIENT_ID = 'ocqpd0b51d5ueh3ge3izu0r5450dup';
  const CLIENT_SECRET = 'vlm9l7epva8m7b8133oz509xumiclz';

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`
    });
    const { access_token } = await tokenRes.json();

    const headers = {
      'Client-ID': CLIENT_ID,
      'Authorization': `Bearer ${access_token}`
    };

    const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${username}`, { headers });
    const userData = await userRes.json();
    if (!userData.data?.length) return res.status(404).json({ error: 'Streamer not found on Twitch' });
    const user = userData.data[0];

    const followRes = await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${user.id}`, { headers });
    const followData = await followRes.json();
    const followers = followData.total?.toLocaleString() || '—';

    const now = new Date();
    const day90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const day60 = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
    const day30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    async function getVideos(afterDate) {
      let videos = [], cursor = null;
      do {
        const url = `https://api.twitch.tv/helix/videos?user_id=${user.id}&type=archive&first=100${cursor ? '&after=' + cursor : ''}`;
        const vRes = await fetch(url, { headers });
        const vData = await vRes.json();
        const filtered = (vData.data || []).filter(v => new Date(v.created_at) >= new Date(afterDate));
        videos = videos.concat(filtered);
        cursor = filtered.length === (vData.data || []).length ? vData.pagination?.cursor : null;
      } while (cursor && videos.length < 500);
      return videos;
    }

    function calcStats(videos) {
      let totalSeconds = 0, activeDays = new Set();
      for (const v of videos) {
        const match = v.duration.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
        if (match) {
          totalSeconds += (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + (parseInt(match[3] || 0));
        }
        activeDays.add(v.created_at.slice(0, 10));
      }
      const totalHours = Math.floor(totalSeconds / 3600);
      const totalMins = Math.floor((totalSeconds % 3600) / 60);
      const weeks = totalSeconds > 0 ? activeDays.size / (totalSeconds / (7 * 24 * 3600)) : 0;
      return {
        broadcastTime: `${totalHours}h ${totalMins}m`,
        activeDays: videos.length ? (activeDays.size / (totalSeconds / (7 * 24 * 3600))).toFixed(1) + ' / wk' : '—',
        hoursWatched: '—'
      };
    }

    const [vids90, vids60, vids30] = await Promise.all([
      getVideos(day90), getVideos(day60), getVideos(day30)
    ]);

    const periods = [
      { days: '3
