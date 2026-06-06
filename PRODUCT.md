# Product

## Register

product

## Users

Club and intermediate players, roughly **1000–2000**. They know the rules cold, read
notation and an eval bar fluently, and play regularly. The context is post-game: they sit
down to understand *why* a game slipped away or where it turned. The job to be done is
concrete: *"Show me where I went wrong, explain why in language I actually get, and show me
the better line on the board."* They want to find and fix real mistakes, not be coddled and
not be buried in engine noise.

## Product Purpose

An AI-native chess analysis app. Import a game (PGN/FEN), step through it with live
Stockfish evaluation, and chat with an agent that explains mistakes, walks variations, and
drives the board to show what it means. Success is a player leaving a session understanding
the **one or two decisive moments** of their game and what to do differently, faster and
more clearly than scrubbing an engine line on their own.

## Brand Personality

Three words: **Lucid, Candid, Mentorly.** The voice is a strong friend who is the better
player, sitting beside you. It names the blunder plainly, explains the idea behind the
better move, never gloats, never coddles. Warm authority. The emotional goal is *"I get it
now"*: respected and equipped, not lectured at and not handed a trophy.

## Anti-references

- **Chess.com gamification**: badges, confetti, coach avatars, reward animations, ad-heavy
  busyness. Motivation-by-bribe.
- **Bloomberg-terminal density**: wall-to-wall data, tiny text, everything competing for
  attention at once.
- **Skeuomorphic chess kitsch**: wood-and-felt boards, marble textures, gold-leaf serif
  headers. Trying-too-hard realism.

## Design Principles

1. **Coach, don't gamify.** The payoff is insight, never a reward animation. Understanding
   is the dopamine.
2. **Show, don't just tell.** Every claim the agent makes is proven by driving the board to
   the position or line. The board is the evidence.
3. **One honest source of truth.** UI and agent read the same engine eval and chess logic.
   Never two numbers that disagree.
4. **Respect the player.** Club players read notation and eval bars. Explain the *why*
   plainly; never dumb down the obvious.
5. **Focus over density.** Surface the decisive one or two moments, not forty equal rows.
   The interface points attention at what mattered *in this game*.

## Accessibility & Inclusion

- **Colorblind-safe**: never encode meaning in red/green alone. Move classifications
  (`?!`/`?`/`??`) and eval advantage pair color with icon, shape, label, or position.
- **WCAG AA contrast**: all text and meaningful UI meets AA in both light and dark themes.
- **Full keyboard navigation**: step through plies, jump moves, and operate core controls
  without a mouse.
