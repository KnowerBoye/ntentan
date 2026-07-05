# Ntentan — Medical Health Assitant For The Visually Impaired

Ntentan is an accessibility-first health tracking platform consisting of a **Flutter mobile application** and a **Node.js/TypeScript API backend**. The platform empowers visually impaired users with voice-driven interactions, real-time medication scanning, and comprehensive health monitoring.

This repository is a **monorepo** that combines both projects as Git submodules.

- **Mobile App**: `./mobile` — Flutter (Android & iOS)
- **API Server**: `./api` — Node.js / Express / TypeScript

---

## Demo Video

[![Ntentan demo video](https://img.youtube.com/vi/8tS7mZt4zA4/maxresdefault.jpg)](https://youtu.be/8tS7mZt4zA4?si=srFwkVKOLvyPbYcF)

**Presentation deck:** [canva.link/1p6p24bnsftp44h](https://canva.link/1p6p24bnsftp44h)

**AI engineering deep-dive:** For a detailed look at the AI engineering stack — the real-time VLM streaming pipeline, agentic tool-calling assistant, semantic prescription matching over Firestore vector search, Twi voice pipeline, and the roadmap toward an in-house fine-tuned VLM — see [docs/technical.md](./docs/technical.md).

---

## Table of Contents

- [Demo Video](#demo-video)
- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
  - [1. Clone with Submodules](#1-clone-with-submodules)
  - [2. API Setup](#2-api-setup)
  - [3. Mobile App Setup](#3-mobile-app-setup)
- [Environment Variables](#environment-variables)
- [Running the Projects](#running-the-projects)
- [Project Documentation](#project-documentation)
  - [API Features](#api-features)
  - [Mobile App Features](#mobile-app-features)
  - [Architecture Highlights](#architecture-highlights)
- [Tech Stack](#tech-stack)

---

## Architecture Overview

```
┌─────────────┐     ┌────────────────┐     ┌─────────────┐
│  Flutter App │◄───►│  Express API   │◄───►│   Google    │
│  (mobile/)   │     │  (api/)        │     │  Gemini AI  │
│              │     │                │     └─────────────┘
│  - Auth      │     │  - Medical     │
│  - Dashboard │     │    Assistant   │     ┌─────────────┐
│  - Voice     │     │  - Medication  │◄───►│  Firebase   │
│    Assistant │     │    Scanner     │     │  Admin SDK  │
│  - Scanner   │     │  - WebSocket   │     │  (Firestore)│
│  - Emergency │     │    (Socket.IO) │     └─────────────┘
│  (SOS)       │     └────────────────┘
└─────────────┘
```

- **Mobile App** communicates with the API via HTTP (REST) and WebSocket (Socket.IO).
- **API** uses Google Gemini AI for conversational medical assistance and medication label reading.
- **API** persists user data in Firebase Firestore.
- **Mobile App** also communicates directly with Firebase Auth and Firestore.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Git](https://git-scm.com/) | Any recent | Clone repository |
| [Node.js](https://nodejs.org/) | v18+ | Run the API server |
| [npm](https://www.npmjs.com/) | v9+ | Install API dependencies |
| [Flutter SDK](https://docs.flutter.dev/get-started/install) | ^3.6.1 | Build the mobile app |
| [Firebase Project](https://console.firebase.google.com/) | — | Authentication & database |
| [Google Gemini API Key](https://aistudio.google.com/apikey) | — | AI assistant features |

You also need a properly configured development environment:
- **Android**: Android Studio + Android SDK
- **iOS**: Xcode (macOS only) + CocoaPods

---

## Getting Started

### 1. Clone with Submodules

Clone the repository **including** both submodules:

```bash
git clone --recurse-submodules https://github.com/KnowerBoye/ntentan.git
cd ntentan
```

If you've already cloned without `--recurse-submodules`, run:

```bash
git submodule update --init --recursive
```

### 2. API Setup

```bash
# Navigate to the API directory
cd api

# Copy the example environment file and fill in your values
cp example.env .env

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the development server with hot-reload
npm run dev
```

> The API server runs on port `8080` by default.

### 3. Mobile App Setup

```bash
# Navigate to the mobile directory
cd mobile

# Install Flutter dependencies
flutter pub get

# Generate code (freezed, drift, json_serializable)
flutter pub run build_runner build --delete-conflicting-outputs

# Generate Firebase configuration
# This creates firebase_options.dart (run only once)
flutterfire configure --project=YOUR_FIREBASE_PROJECT_ID

# Create environment file
touch .env
# Add your environment variables (see section below)

# Run the app on a connected device or emulator
flutter run
```

> **Note**: The app uses Flutter flavors (`dev` / `prod`). To run a specific flavor:
> ```bash
> flutter run --flavor dev -t lib/main_dev.dart
> ```
> _(Adjust the entry point based on your flavor configuration.)_

---

## Environment Variables

### API (`api/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key for the medical assistant |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID for Firestore |
| `FIREBASE_CLIENT_EMAIL` | Yes | Firebase service account client email |
| `FIREBASE_PRIVATE_KEY` | Yes | Firebase service account private key |
| `PORT` | No | Server port (default: `8080`) |

### Mobile (`mobile/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `API_BASE_URL` | Yes | API server URL (e.g., `http://10.0.2.2:8080` for Android emulator) |

> The mobile app also needs Firebase configuration files (`google-services.json` for Android, `GoogleService-Info.plist` for iOS) placed in their respective platform directories, or generated via `flutterfire configure`.

---

## Running the Projects

| Command | Description |
|---------|-------------|
| `cd api && npm run dev` | Start API dev server with hot-reload |
| `cd api && npm run build` | Build API TypeScript → JavaScript |
| `cd api && npm start` | Start production API server |
| `cd mobile && flutter run` | Run mobile app on connected device |
| `cd mobile && flutter test` | Run mobile app test suite |
| `cd mobile && flutter pub run build_runner build` | Regenerate code (freezed/drift) |

---

## Project Documentation

### API Features

- **Medical Assistant Chat** — Conversational AI powered by Google Gemini 2.0 Flash with tool-calling capabilities:
  - `query_prescriptions` — Fetches prescription data for authenticated users
  - `search_drug_info` — Looks up FDA drug label information via OpenFDA
  - System prompt ensures safety rules (no diagnosis, no dosage recommendations)
- **Medication Scanner** — Real-time video stream processing via Socket.IO. The AI analyzes camera frames to detect and read medication labels.
- **Firebase Integration** — Firestore for user data and prescriptions storage.

### Mobile App Features

- **Accessibility-First Design** — Text-to-speech, voice commands, haptic feedback, high-contrast UI
- **Voice Assistant** — Record audio queries, send to API, receive spoken responses
- **Medication Scanner** — Use the device camera to scan medication labels with AI assistance
- **Dashboard** — Health metrics overview and medication reminders
- **Emergency (SOS)** — Trigger emergency alerts with GPS location sharing
- **Authentication** — Email/password and Google Sign-In via Firebase
- **Offline-First** — Local SQLite database using Drift for offline capability
- **Multi-Environment** — Dev and prod flavors with separate configurations

### Architecture Highlights

- **Feature-First Clean Architecture** — Code organized by business domain, not technical layer
- **Functional Error Handling** — Uses `Either<Failure, Success>` pattern via `fpdart` for predictable error handling
- **Immutable State** — Freezed for immutable state classes and union types
- **Dependency Injection** — GetIt service locator with per-feature injection containers
- **Declarative Routing** — GoRouter with guards for auth-protected routes

> For detailed mobile app documentation, see the [mobile README](./mobile/README.md).

---

## Tech Stack

### API

| Technology | Purpose |
|------------|---------|
| Node.js + Express | HTTP server |
| TypeScript | Type-safe development |
| Google GenAI SDK | Gemini AI integration |
| Firebase Admin SDK | Firestore database |
| Socket.IO | Real-time WebSocket communication |
| date-fns | Date manipulation |

### Mobile

| Technology | Purpose |
|------------|---------|
| Flutter + Dart | Cross-platform UI framework |
| Provider | State management |
| Freezed | Immutable state & code generation |
| fpdart | Functional programming (Either type) |
| GoRouter | Declarative routing & guards |
| GetIt | Dependency injection |
| Drift | Local SQLite persistence |
| Dio | HTTP client with interceptors |
| Socket.IO Client | WebSocket communication |
| Firebase Auth | Authentication |
| Cloud Firestore | Remote database |
| Flutter TTS | Text-to-speech |
| Lottie | Animations |

---

> **Note**: This project uses Git submodules. Always use `git submodule update --init --recursive` after pulling changes that update submodule references.