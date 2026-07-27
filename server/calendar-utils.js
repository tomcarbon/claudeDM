const crypto = require('crypto');

// In-memory calendar state per session context
const calendarStates = new Map();

function getContextKey(playerEmail, campaignId, sessionId) {
  if (sessionId) return `sess:${sessionId}`;
  return `${playerEmail || 'guest'}:${campaignId || 'demo'}`;
}

const WEATHER_TABLE = [
  { type: 'Clear', desc: 'Clear skies, good visibility.' },
  { type: 'Partly Cloudy', desc: 'Scattered clouds, mild breeze.' },
  { type: 'Overcast', desc: 'Heavy cloud cover, grey skies.' },
  { type: 'Light Rain', desc: 'Gentle rain, slightly reduced visibility.' },
  { type: 'Heavy Rain', desc: 'Downpour. Disadvantage on Perception checks relying on sight. Ranged attacks at disadvantage beyond normal range.' },
  { type: 'Fog', desc: 'Thick fog. Heavily obscured beyond 30 feet.' },
  { type: 'Wind', desc: 'Strong winds. Disadvantage on ranged weapon attacks. Open flames extinguished.' },
  { type: 'Storm', desc: 'Thunder and lightning. Heavy rain, strong winds. Deafening thunder makes hearing difficult. Lightning strikes possible.' },
  { type: 'Snow', desc: 'Snowfall. Difficult terrain, reduced visibility. Constitution saves for extended exposure.' },
  { type: 'Extreme Cold', desc: 'Bitter cold. DC 10 Constitution save each hour or gain 1 level of exhaustion. Resistance to cold negates.' },
  { type: 'Extreme Heat', desc: 'Scorching heat. DC 5 Constitution save each hour (+1 per hour) or gain 1 level of exhaustion. Water consumption doubled.' },
  { type: 'Beautiful', desc: 'Perfect weather. Warm sun, gentle breeze, birdsong. Party morale high.' },
];

function getOrCreateCalendar(playerEmail, campaignId, sessionId) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  if (!calendarStates.has(key)) {
    calendarStates.set(key, {
      day: 1,
      hour: 8, // Start at 8 AM
      events: [],
      weatherToday: null,
    });
  }
  return calendarStates.get(key);
}

function advanceTime(playerEmail, campaignId, sessionId, days, hours) {
  const cal = getOrCreateCalendar(playerEmail, campaignId, sessionId);

  const totalHours = (days || 0) * 24 + (hours || 0);
  cal.hour += totalHours;
  while (cal.hour >= 24) {
    cal.hour -= 24;
    cal.day++;
    cal.weatherToday = null; // Reset weather for new day
  }

  // Check for triggered events
  const triggered = cal.events.filter(e => e.onDay <= cal.day);
  const upcoming = cal.events.filter(e => e.onDay > cal.day);
  cal.events = upcoming;

  const timeOfDay = cal.hour < 6 ? 'night' : cal.hour < 12 ? 'morning' : cal.hour < 18 ? 'afternoon' : 'evening';

  return {
    action: 'advance',
    day: cal.day,
    hour: cal.hour,
    timeOfDay,
    advanced: { days: days || 0, hours: hours || 0 },
    triggeredEvents: triggered.length > 0 ? triggered.map(e => e.name) : null,
    upcomingEvents: upcoming.length > 0 ? upcoming.map(e => ({ name: e.name, inDays: e.onDay - cal.day })) : null,
  };
}

function scheduleEvent(playerEmail, campaignId, sessionId, name, inDays) {
  const cal = getOrCreateCalendar(playerEmail, campaignId, sessionId);
  const onDay = cal.day + (inDays || 1);
  cal.events.push({ name, onDay });
  cal.events.sort((a, b) => a.onDay - b.onDay);

  return {
    action: 'event',
    scheduled: name,
    onDay,
    inDays: inDays || 1,
    allEvents: cal.events.map(e => ({ name: e.name, onDay: e.onDay, inDays: e.onDay - cal.day })),
  };
}

function checkCalendar(playerEmail, campaignId, sessionId) {
  const cal = getOrCreateCalendar(playerEmail, campaignId, sessionId);
  const timeOfDay = cal.hour < 6 ? 'night' : cal.hour < 12 ? 'morning' : cal.hour < 18 ? 'afternoon' : 'evening';

  return {
    action: 'check',
    day: cal.day,
    hour: cal.hour,
    timeOfDay,
    weather: cal.weatherToday,
    events: cal.events.map(e => ({ name: e.name, onDay: e.onDay, inDays: e.onDay - cal.day })),
  };
}

function generateWeather(playerEmail, campaignId, sessionId) {
  const cal = getOrCreateCalendar(playerEmail, campaignId, sessionId);

  // If weather already generated today, return it
  if (cal.weatherToday) return { action: 'weather', day: cal.day, ...cal.weatherToday, cached: true };

  const roll = crypto.randomInt(0, WEATHER_TABLE.length);
  const weather = WEATHER_TABLE[roll];
  cal.weatherToday = weather;

  return {
    action: 'weather',
    day: cal.day,
    type: weather.type,
    desc: weather.desc,
    cached: false,
  };
}

module.exports = { advanceTime, scheduleEvent, checkCalendar, generateWeather };
