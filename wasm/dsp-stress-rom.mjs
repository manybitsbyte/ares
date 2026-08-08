//Builds a minimal LoROM image that drives the SNES APU hard enough to be worth measuring.
//
//The smoke ROM parks the 65816 in a branch-to-self and never touches the APU, so its "audio" is
//denormal silence: comparing it across DSP sync granularities proves nothing. This image instead
//uploads an SPC700 program over the IPL boot protocol, points the DSP at a BRR sample, keys on four
//voices at different pitches, and enables the echo unit — which makes the DSP write back into APU
//RAM. That write-back, plus optional sample rewriting from the SMP, is the coherency hazard that
//batched SMP/DSP synchronization actually trades against.
//
//Modes:
//  "static"    voices + echo, sample data left alone. Representative of a normal game.
//  "streaming" additionally rewrites a BRR data byte from the SMP as fast as it can, so the DSP and
//              SMP race on the same APU RAM byte. A deliberate worst case, not realistic.

const APU_PORT0 = 0x2140;

//APU RAM layout. The uploaded block is contiguous from CODE through the end of the sample.
const APU_CODE = 0x0200;
const APU_DIR = 0x0400;   //sample directory, 4 bytes per entry, must be page aligned
const APU_BRR = 0x0500;   //BRR sample data
const APU_ECHO_PAGE = 0x10;  //echo buffer at $1000, clear of everything above

const VOICES = 4;
const VOICE_PITCH = [0x1000, 0x0800, 0x1800, 0x0c00];
const BRR_BLOCKS = 4;  //64 samples per period

//BRR filter 0 decodes to (nibble << shift) >> 1; shift 12 puts a +-7 nibble at a healthy amplitude.
const BRR_SHIFT = 12;

function encodeBrr() {
  const bytes = [];
  const samples = BRR_BLOCKS * 16;
  for(let block = 0; block < BRR_BLOCKS; block++) {
    const last = block === BRR_BLOCKS - 1;
    //header: shift<<4 | filter<<2 | loop<<1 | end
    bytes.push(BRR_SHIFT << 4 | (last ? 0b11 : 0b00));
    for(let pair = 0; pair < 8; pair++) {
      const nibble = index => {
        const value = Math.round(7 * Math.sin(2 * Math.PI * index / samples));
        return Math.max(-8, Math.min(7, value)) & 0x0f;
      };
      const i = block * 16 + pair * 2;
      bytes.push(nibble(i) << 4 | nibble(i + 1));
    }
  }
  return bytes;
}

//SPC700 emitters. `MOV dp,#imm` is 8F imm dp, exactly as the IPL ROM uses it.
function spc700(mode) {
  const code = [];
  const movDp = (dp, imm) => code.push(0x8f, imm, dp);
  const dsp = (register, value) => { movDp(0xf2, register); movDp(0xf3, value); };

  dsp(0x6c, 0x20);  //FLG: out of reset and unmuted, echo writes still disabled
  dsp(0x0c, 0x50);  //MVOLL
  dsp(0x1c, 0x50);  //MVOLR
  dsp(0x2c, 0x28);  //EVOLL
  dsp(0x3c, 0x28);  //EVOLR
  dsp(0x0d, 0x30);  //EFB, so the echo buffer feeds back on itself
  dsp(0x0f, 0x7f);  //FIR0, remaining taps stay zero
  for(let tap = 1; tap < 8; tap++) dsp(tap * 16 + 0x0f, 0x00);
  dsp(0x5d, APU_DIR >> 8);      //DIR
  dsp(0x6d, APU_ECHO_PAGE);     //ESA
  dsp(0x7d, 0x01);              //EDL: one 2 KiB echo buffer
  dsp(0x5c, 0xff);              //KOF everything, then release
  dsp(0x5c, 0x00);

  for(let voice = 0; voice < VOICES; voice++) {
    const base = voice * 16;
    dsp(base + 0x00, 0x28);                        //VOLL
    dsp(base + 0x01, 0x28);                        //VOLR
    dsp(base + 0x02, VOICE_PITCH[voice] & 0xff);   //PITCHL
    dsp(base + 0x03, VOICE_PITCH[voice] >> 8);     //PITCHH
    dsp(base + 0x04, 0x00);                        //SRCN, all voices share sample 0
    dsp(base + 0x05, 0x00);                        //ADSR1: ADSR off, use direct GAIN
    dsp(base + 0x07, 0x7f);                        //GAIN: direct, maximum
  }

  const voiceMask = (1 << VOICES) - 1;
  dsp(0x4d, voiceMask);  //EON: every voice feeds the echo unit
  dsp(0x6c, 0x00);       //FLG: enable echo writes into APU RAM
  dsp(0x4c, voiceMask);  //KON

  const loop = code.length;
  if(mode === "streaming") {
    //Race the DSP for one BRR data byte. Headers are left intact so the sample stays decodable.
    const target = APU_BRR + 5;
    code.push(0xe5, target & 0xff, target >> 8);  //MOV A,!target
    code.push(0x48, 0x0f);                        //EOR A,#$0f
    code.push(0xc5, target & 0xff, target >> 8);  //MOV !target,A
  }
  const rel = loop - (code.length + 2);
  code.push(0x2f, rel & 0xff);  //BRA loop

  return code;
}

function apuPayload(mode) {
  const code = spc700(mode);
  const brr = encodeBrr();
  const length = (APU_BRR - APU_CODE) + brr.length;
  const payload = new Uint8Array(length);
  if(code.length > APU_DIR - APU_CODE) throw new Error("SPC700 code overruns the directory");
  payload.set(code, 0);
  //directory entry 0: start and loop both point at the sample
  payload.set([APU_BRR & 0xff, APU_BRR >> 8, APU_BRR & 0xff, APU_BRR >> 8], APU_DIR - APU_CODE);
  payload.set(brr, APU_BRR - APU_CODE);
  return payload;
}

//65816 uploader. Native mode, 8-bit accumulator, 16-bit index so the payload can exceed 256 bytes.
function uploader(payloadAddress, payloadLength) {
  const code = [];
  const at = () => code.length;
  const byte = (...b) => code.push(...b);
  const lda = value => byte(0xa9, value);          //LDA #imm8
  const sta = addr => byte(0x8d, addr & 0xff, addr >> 8);
  const ldaAbs = addr => byte(0xad, addr & 0xff, addr >> 8);
  const cmpAbs = addr => byte(0xcd, addr & 0xff, addr >> 8);
  //branch back to `target`, patched as a signed 8-bit displacement
  const bne = target => byte(0xd0, (target - (at() + 2)) & 0xff);

  byte(0x78);              //SEI
  byte(0x18);              //CLC
  byte(0xfb);              //XCE, enter native mode
  byte(0xc2, 0x10);        //REP #$10, 16-bit index
  byte(0xe2, 0x20);        //SEP #$20, 8-bit accumulator

  //Wait for the IPL ROM handshake: port0 = $AA, port1 = $BB.
  const handshake = at();
  ldaAbs(APU_PORT0 + 0); byte(0xc9, 0xaa); bne(handshake);
  ldaAbs(APU_PORT0 + 1); byte(0xc9, 0xbb); bne(handshake);

  //Destination address, then a non-zero port1 to request a data transfer, then the $CC kickoff.
  lda(APU_CODE & 0xff); sta(APU_PORT0 + 2);
  lda(APU_CODE >> 8); sta(APU_PORT0 + 3);
  lda(0x01); sta(APU_PORT0 + 1);
  lda(0xcc); sta(APU_PORT0 + 0);
  const ack = at();
  ldaAbs(APU_PORT0 + 0); byte(0xc9, 0xcc); bne(ack);

  //Per byte: data to port1, running index to port0, then wait for the index to be echoed back.
  byte(0xa2, 0x00, 0x00);  //LDX #$0000
  const transfer = at();
  byte(0xbd, payloadAddress & 0xff, payloadAddress >> 8);  //LDA payload,X
  sta(APU_PORT0 + 1);
  byte(0x8a);              //TXA, low byte of the index
  sta(APU_PORT0 + 0);
  const echo = at();
  cmpAbs(APU_PORT0 + 0); bne(echo);
  byte(0xe8);              //INX
  byte(0xe0, payloadLength & 0xff, payloadLength >> 8);  //CPX #length
  bne(transfer);

  //Zero in port1 ends the transfer; port0 must be the next index plus two so the IPL falls through
  //to its jump path with the entry address taken from ports 2 and 3.
  lda(0x00); sta(APU_PORT0 + 1);
  lda(APU_CODE & 0xff); sta(APU_PORT0 + 2);
  lda(APU_CODE >> 8); sta(APU_PORT0 + 3);
  byte(0x8a);              //TXA
  byte(0x18);              //CLC
  byte(0x69, 0x02);        //ADC #$02
  sta(APU_PORT0 + 0);

  const idle = at();
  byte(0x80, (idle - (at() + 2)) & 0xff);  //BRA self

  return code;
}

export function buildDspStressRom(mode = "static") {
  if(mode !== "static" && mode !== "streaming") throw new Error(`unknown mode: ${mode}`);
  const rom = new Uint8Array(32 * 1024);

  //Reserve a fixed slot for the uploader so the payload address is known before it is assembled.
  const PAYLOAD_OFFSET = 0x0200;
  const payload = apuPayload(mode);
  const code = uploader(0x8000 + PAYLOAD_OFFSET, payload.length);
  if(code.length > PAYLOAD_OFFSET) throw new Error("uploader overruns the payload");
  rom.set(code, 0);
  rom.set(payload, PAYLOAD_OFFSET);

  const header = 0x7fc0;
  rom.set(new TextEncoder().encode("ARES DSP STRESS      "), header);
  rom.set([0x20, 0x00, 0x05, 0x00, 0x01, 0x00, 0x00], header + 0x15);
  for(let vector = 0x7fe4; vector <= 0x7ffe; vector += 2) {
    rom[vector + 0] = 0x00;
    rom[vector + 1] = 0x80;
  }

  rom.fill(0, header + 0x1c, header + 0x20);
  const checksum = (rom.reduce((sum, b) => sum + b, 0) + 0x1fe) & 0xffff;
  const complement = checksum ^ 0xffff;
  rom[header + 0x1c] = complement & 0xff;
  rom[header + 0x1d] = complement >> 8;
  rom[header + 0x1e] = checksum & 0xff;
  rom[header + 0x1f] = checksum >> 8;
  return rom;
}
