# Tic Tac Toe

A clean, mobile-friendly Tic Tac Toe web app. Play a friend locally on one
device, or challenge the CPU (easy or unbeatable minimax). No build step,
no dependencies — plain HTML/CSS/JS.

Features:
- Mobile-first, touch-friendly layout with safe-area support for notches
- Vs CPU (unbeatable minimax, or an easy mode) or 2-player local
- Score tracking, win-line animation, light/dark theme, sound + haptics
- Installable as a home-screen PWA (manifest + icon)

## Play it locally

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Host on GitHub Pages

This repo includes a GitHub Actions workflow
(`.github/workflows/deploy-pages.yml`) that deploys the site automatically.

1. In the repo, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the **Actions** tab).
4. Your game will be live at `https://<username>.github.io/<repo>/`.

On mobile, open that URL and use "Add to Home Screen" for an app-like
experience.
