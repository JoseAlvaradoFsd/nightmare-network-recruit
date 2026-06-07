export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'No username provided' });

  const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
  const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

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

    const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`, { headers });
    const userData = await userRes.json();
    if (!userData.data?.length) return res.status(404).json({ error: 'Streamer not found' });
    const user = userData.data[0];

    const [followRes, videoRes, streamRes] = await Promise.all([
      fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${user.id}&first=1`, { headers }),
      fetch(`https://api.twitch.tv/helix/videos?user_id=${user.id}&type=archive&first=100`, { headers }),
      fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(username)}`, { headers })
    ]);

    const [followData, videoData, streamData] = await Promise.all([
      followRes.json(), videoRes.json(), streamRes.json()
    ]);

    const followers = followData.total?.toLocaleString() ?? '—';
    const avgViewers = streamData.data?.[0]?.viewer_count?.toLocaleString() ?? '—';
    const videos = videoData.data || [];

    function parseSecs(dur) {
      const m = dur?.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/) || [];
      return (parseInt(m[1]||0)*3600)+(parseInt(m[2]||0)*60)+(parseInt(m[3]||0));
    }

    function calcPeriod(days) {
      const cutoff = Date.now() - days * 864e5;
      const vids = videos.filter(v => new Date(v.created_at).getTime() >= cutoff);
      if (!vids.length) return { broadcastTime: '0h 0m', activeDays: '0.0 / wk', hoursWatched: '—' };
      const secs = vids.reduce((a, v) => a + parseSecs(v.duration), 0);
      const daySet = new Set(vids.map(v => v.created_at.slice(0,10)));
      const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
      return {
        broadcastTime: `${h}h ${m}m`,
        activeDays: `${(daySet.size/(days/7)).toFixed(1)} / wk`,
        hoursWatched: '—'
      };
    }

    const periods = [
      { days: '30', ...calcPeriod(30) },
      { days: '60', ...calcPeriod(60) },
      { days: '90', ...calcPeriod(90) }
    ];

    const horrorKeywords = ['horror','resident evil','silent hill','outlast','amnesia','visage','phasmophobia','alien isolation','until dawn','soma','layers of fear','little nightmares','fnaf','five nights','lethal company','content warning','devour','labyrinthine','granny','poppy','doors','forewarned','puppet combo'];
    const gameIds = [...new Set(videos.map(v => v.game_id).filter(Boolean))].slice(0, 100);
    let horrorGames = [];

    if (gameIds.length) {
      const gRes = await fetch(`https://api.twitch.tv/helix/games?${gameIds.map(id=>`id=${id}`).join('&')}`, { headers });
      const gData = await gRes.json();
      const nameMap = Object.fromEntries((gData.data||[]).map(g => [g.id, g.name]));
      const seen = new Set();
      for (const v of videos) {
        if (horrorGames.length >= 5) break;
        const name = nameMap[v.game_id];
        if (name && !seen.has(name) && horrorKeywords.some(k => name.toLowerCase().includes(k))) {
          seen.add(name);
          horrorGames.push({ name, date: new Date(v.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) });
        }
      }
    }

    res.json({ displayName: user.display_name, followers, avgViewers, peakViewers: '—', periods, horrorGames, url: `https://twitchtracker.com/${username}` });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
