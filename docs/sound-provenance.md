# Practice sound pack

The files in `assets/sounds/practice/` are original practice audio made for The Allsparks. They are not recordings from FTC Live, the field, or a match video.

FIRST lists the match cues in Game Manual Part 1, Table 9-1, and does not publish the Live recordings for teams to copy. Copies on sound boards and in other projects are not licensed for this pack, so they are not included. The generated cues follow that table: a charge when the match starts, three buzzers when AUTO ends, “Drivers, pick up your controllers,” a spoken number for each second from 8 through 1, three bells when TELEOP starts, a chime when flower ownership unlocks, a train whistle at 20 seconds, a three-second buzzer at match end, and a foghorn when the match is stopped.

Tones are generated in `scripts/generate-sounds.mjs`. Spoken words are rendered once at build time and stored as WAV files. The page never calls `speechSynthesis`. The end buzzer is a loud high chopped buzz for the full three seconds, so a laptop or Chromebook speaker can play it. A low sine at that length is nearly silent on those speakers. The timer starts that buzzer when the match clock reaches zero, instead of lining it up at the beginning of the match.

`pack.json` records each cue’s duration, source, license, trim, and alignment. “GO” and each countdown number are aligned to the spoken onset. The pickup line and the word “eight” start when the three buzzers finish. “Seven” through “one” start on those transition seconds, and the bells start at TELEOP. `node test/machine.test.mjs` checks those alignments against the WAV files.

A team can import another pack in Settings. An imported pack must use the same metadata fields. A run keeps the pack it started with.
