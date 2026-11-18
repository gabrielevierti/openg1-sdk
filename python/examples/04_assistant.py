"""Even AI, pointed at your own model.

Hold the left touchbar, speak, let go. The microphone stream comes back as
LC3; hand it to whatever speech-to-text and language model you want and the
answer goes on the display with the AI status nibble set, so the touchbar can
page through it exactly as the official feature does.

Nothing here talks to Even's servers.
"""

import asyncio

from _common import glasses  # noqa: E402  (also fixes sys.path)

from openg1.lc3 import AudioBuffer


async def responder(audio: AudioBuffer) -> str:
    # Real version:
    #   pcm  = audio.decode_pcm()            # needs pip install 'openg1[audio]'
    #   text = await my_speech_to_text(pcm)
    #   return await my_llm(text)
    return f"heard {audio.duration_s:.1f}s ({audio.frame_count} frames)"


async def main() -> None:
    async with glasses() as (g1, sim):
        if sim:
            task = asyncio.create_task(g1.ai.run(responder, max_record_s=0.5,
                                                 thinking_message=""))
            await asyncio.sleep(0.1)
            await sim.hold()                       # wearer presses
            await asyncio.sleep(0.05)                  # let the mic come up
            for i in range(30):
                await sim.audio_frame(i, bytes(20))
            await asyncio.sleep(0.1)
            await sim.hold(release=True)           # wearer lets go
            await task
            print("displayed:", sim.emulator.left.screen_text)
            return

        print("hold the left touchbar and speak. ctrl-c to stop.")
        g1.ai.listen(responder)
        await asyncio.Event().wait()


asyncio.run(main())
