const mongoose = require('mongoose');

const downloadSchema = new mongoose.Schema({
  videoUrl: {
    type: String,
    required: true
  },
  videoTitle: {
    type: String,
    required: true
  },
  format: {
    type: String,
    enum: ['highest', 'lowest', 'audio'],
    default: 'highest'
  },
  downloadDate: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Download', downloadSchema);