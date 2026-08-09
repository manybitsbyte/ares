auto DSP::serialize(serializer& s) -> void {
  Thread::serialize(s);

  s(apuram);
  s(registers);

  s(clock.counter);
  s(clock.sample);

  #if defined(PLATFORM_WEB)
  //main() spans a whole sample cycle, so phase is 0 at every synchronized safe point; only a
  //run-ahead state can be taken mid-cycle, where SMP::catchUpDSP() left off. gating on the same
  //condition Thread::serialize() uses for the cothread stack keeps the synchronized layout intact.
  if(!scheduler.getSynchronize()) s(phase);
  #endif

  s(mainvol.reset);
  s(mainvol.mute);
  s(mainvol.volume);
  s(mainvol.output);

  s(echo.feedback);
  s(echo.volume);
  s(echo.fir);
  s(echo.history[0]);
  s(echo.history[1]);
  s(echo.page);
  s(echo.delay);
  s(echo.readonly);
  s(echo.input);
  s(echo.output);
  s(echo._page);
  s(echo._readonly);
  s(echo._address);
  s(echo._offset);
  s(echo._length);
  s(echo._historyOffset);

  s(noise.frequency);
  s(noise.lfsr);

  s(brr.bank);
  s(brr._bank);
  s(brr._source);
  s(brr._address);
  s(brr._nextAddress);
  s(brr._header);
  s(brr._byte);

  s(latch.adsr0);
  s(latch.envx);
  s(latch.outx);
  s(latch.pitch);
  s(latch.output);

  for(auto& v : voice) s(v);
}

auto DSP::Voice::serialize(serializer& s) -> void {
  s(index);

  s(volume);
  s(pitch);
  s(source);
  s(adsr0);
  s(adsr1);
  s(gain);
  s(envx);
  s(keyon);
  s(keyoff);
  s(modulate);
  s(noise);
  s(echo);
  s(end);

  s(buffer);
  s(bufferOffset);
  s(gaussianOffset);
  s(brrAddress);
  s(brrOffset);
  s(keyonDelay);
  s(envelopeMode);
  s(envelope);

  s(_envelope);
  s(_keylatch);
  s(_keyon);
  s(_keyoff);
  s(_modulate);
  s(_noise);
  s(_echo);
  s(_end);
  s(_looped);
}
