const { DEFAULT_CAMPAIGN } = require('./player-data');

function getCampaignId(req) {
  const campaignId = String(req.get('x-campaign-id') || '').trim().toLowerCase();
  return campaignId || DEFAULT_CAMPAIGN;
}

function campaignContext() {
  return (req, res, next) => {
    req.campaignId = getCampaignId(req);
    next();
  };
}

module.exports = { campaignContext, getCampaignId };
