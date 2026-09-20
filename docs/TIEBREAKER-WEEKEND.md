# Tiebreaker weekend

Both leagues use the same rules for newly scheduled tiebreakers:

- Apply regular-season points, game differential, series wins, then the tied
  teams’ head-to-head points and game differential first.
- A remaining tie affecting qualification or seeds uses BO1 single elimination.
  One loss ends a team’s run; no team plays more than three games.
- For qualification ties, create one bracket per available place, adding more
  brackets only when needed to keep every bracket at eight teams or fewer.
  Seeding-only ties use the fewest brackets needed for that same limit.
- Draw all tied teams once. Fill smaller brackets first in draw order; the
  first entrants within each bracket receive any opening byes. A one-team
  qualifying bracket is an automatic qualification. For example, three teams
  for two places means one qualifying bye and one BO1 for the other place.
- Bracket winners rank first. Other teams rank by how close to their bracket’s
  final they finished. Equal finishes use the original draw order. When a very
  large tie needs more brackets than available places, draw order separates
  the bracket winners for qualification. Everyone has a bracket entry; no
  fourth game or repeated round is added.
- All ready opening games share the league’s next match-night kickoff. Each
  dependent game is created as soon as its own feeders finish, in the same
  league week, without a scheduled break. Different branches run independently.
  An administrator can set missing opening times or correct logistics.
- Playoffs remain locked until all required games finish. Tiebreakers never
  change regular-season points. Already-published BO3 and BO1 double-elimination
  fixtures retain their original rules and results.

The public schedule and Admin → Tiebreakers show the complete draw, byes,
future match slots and result controls for real fixtures. A reset retains the
draw for the same regular-season standings. Result corrections lock only after
the dependent fixture exists. A missed post-result advancement is retried by
the existing automation loop; no additional scheduler is introduced.

The cap is on games, not their duration. Teams may wait for their next opponent
to finish; independent matches do not wait for a whole round to end.
