# YouTube Downloader - Server

A powerful Node.js backend service for downloading YouTube videos and audio files. This application provides a complete API for extracting video information and downloading content in various formats.

## Features

- Extract video metadata (title, author, thumbnail, duration)
- Download videos in different quality formats
- Download audio-only files
- Store download history in MongoDB
- RESTful API for easy frontend integration

## Tech Stack

- Node.js
- Express.js
- MongoDB with Mongoose
- @distube/ytdl-core for YouTube interaction
- CORS support for cross-origin requests
- dotenv for environment variable management

## Installation

### Prerequisites

- Node.js (v14+)
- MongoDB (local or Atlas)

### Steps

1. Clone this repository
2. Install dependencies

```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:

```
PORT=5000
MONGO_URI=your_mongodb_connection_string
```

## API Endpoints

### Get Video Information

- **URL**: `/api/video-info`
- **Method**: POST
- **Body**:
  ```json
  {
    "url": "https://www.youtube.com/watch?v=example"
  }
  ```
- **Response**: Video metadata including available formats

### Download Video/Audio

- **URL**: `/api/download`
- **Method**: GET
- **Query Parameters**:
  - `url`: YouTube video URL
  - `format`: One of "highest", "lowest", or "audio"
- **Response**: Stream of the requested file

## Usage

### Start Development Server

```bash
npm run dev
```

### Start Production Server

```bash
npm start
```

## Data Model

The application stores download history with the following schema:

- **videoUrl**: URL of the downloaded video
- **videoTitle**: Title of the video
- **format**: Download format (highest, lowest, audio)
- **downloadDate**: When the download occurred

## Project Structure

```
├── server.js          # Main application entry point
├── models/
│   └── Download.js    # MongoDB schema for downloads
├── downloads/         # Directory for storing downloaded files
└── package.json       # Project dependencies and scripts
```

## License

[MIT](https://opensource.org/licenses/MIT)
