export default recordCanvas;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {() => boolean} renderNextFrame returns true for last frame
 * @returns {Promise<Blob>}
 */
async function recordCanvas(
  canvas,
  renderNextFrame, // vp8 is always compressed for some reason in chrome 81, use vp9
  { mediaType = "video/webm;codecs=vp9", fps = 60, bitsPerSecond = undefined } = {}
) {
  if (!window.MediaRecorder) {
    throw new Error("MediaRecorder not available");
  }
  if (!MediaRecorder.isTypeSupported(mediaType)) {
    mediaType = "video/webm" // fallback
    if (!MediaRecorder.isTypeSupported(mediaType)) {
      throw new Error(`Not supported: ${mediaType}`);
    }
  }

  // @ts-ignore
  const stream = canvas.captureStream();
  const recorder = new MediaRecorder(stream, {
    mimeType: mediaType,
    bitsPerSecond
  });
  const chunks = [];

  let dataAvailablePromiseCb
  let dataAvailablePromise = new Promise(resolve => {
    dataAvailablePromiseCb = resolve
  })
  recorder.ondataavailable = e => {
    if (e.data.size > 0) {
      chunks.push(e.data);
    }
    dataAvailablePromiseCb()
  };

  const recorderStop = new Promise(resolve => {
    recorder.onstop = resolve;
  });

  let first = true;
  let last = false;
  let numFrames = 0;

  recorder.start(1000 / fps / 2);

  // initial delay needed to capture first frame
  await new Promise(requestAnimationFrame);
  while (!last) {
    last = renderNextFrame();
    numFrames++;

    if (first) {
      first = false;
      // initial delay needed to capture first frame
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // wait for frame to appear on the screen
    // await new Promise(requestAnimationFrame);
    await Promise.race([dataAvailablePromise, new Promise(resolve => setTimeout(resolve, 500))]);

    dataAvailablePromise = new Promise(resolve => {
      dataAvailablePromiseCb = resolve
    })
  }
  // final delay needed to capture last few frames
  await new Promise(resolve => setTimeout(resolve, 1000));

  recorder.stop();

  await recorderStop;

  try {
    const buffer = await readBlob(new Blob(chunks))
    const newChunks = await fixFPS(
      buffer,
      fps,
      numFrames
    );

    const out = new Blob(newChunks, { type: mediaType });

    return out;
  } catch (err) {
    console.error(err)
    alert(`Failed to fix FPS! The recording was probably too big.\n\n${err.name}: ${err.message}`)
    return new Blob(chunks, { type: mediaType })
  }
}

// prettier-ignore
const UNKNOWN_SIZE = new Uint8Array([ 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff ]);
const INT32_SIZE = new Uint8Array([0x84]);
/**
 * @param {ArrayBuffer} buffer
 * @param {number} fps
 * @param {number} numFrames
 * @returns {Promise<BlobPart[]>}
 * */
async function fixFPS(buffer, fps, numFrames) {
  /** @type {BlobPart[]} */
  const chunks = [];
  let frameIndex = 0;
  let clusterFrameIndex = 0;
  let timecodeScaleSize;

  /** @type {Record<string, (el: {
    tag: string,
    tagBytes: DataView,
    sizeBytes: DataView,
    start: number,
    length: number
  }) => void>} */
  const elementHandlers = {
    Info: el => {
      let infoSize = el.length;
      const infoSizeBytes = new DataView(new ArrayBuffer(5));
      infoSizeBytes.setUint8(0, 0x08);

      chunks.push(el.tagBytes, infoSizeBytes);

      parse(el.start, el.length);

      infoSize += 4 - timecodeScaleSize;

      // add duration
      const duration = (numFrames / fps) * 1000;
      const durationBytes = new DataView(new ArrayBuffer(8));
      durationBytes.setFloat64(0, duration);
      chunks.push(new Uint8Array([0x44, 0x89, 0x88]), durationBytes);
      infoSize += 3 + 8;

      infoSizeBytes.setUint32(1, infoSize);
    },
    Segment: el => {
      chunks.push(el.tagBytes, UNKNOWN_SIZE);
      parse(el.start, el.length);
    },
    Cluster: el => {
      frameIndex = 0;

      chunks.push(el.tagBytes, UNKNOWN_SIZE);
      parse(el.start, el.length);
    },
    TimecodeScale: el => {
      // should be 1000000 by default but make sure
      timecodeScaleSize = el.length;
      const timecodeScale = new DataView(new ArrayBuffer(4));
      timecodeScale.setUint32(0, 1000000);

      chunks.push(el.tagBytes, INT32_SIZE, timecodeScale);
    },
    Duration: el => {
      // ignore
    },
    Timecode: el => {
      // rewrite cluster timecode
      const timecode = new DataView(new ArrayBuffer(4));
      timecode.setUint32(0, Math.round((clusterFrameIndex * 1000) / fps));
      chunks.push(el.tagBytes, INT32_SIZE, timecode);
    },
    SimpleBlock: el => {
      const data = new DataView(buffer, el.start, el.length);

      // rewrite block timecode
      data.setInt16(1, Math.round((frameIndex * 1000) / fps), false);

      frameIndex++;
      clusterFrameIndex++;

      chunks.push(el.tagBytes, el.sizeBytes, data);
    }
  };

  parse(0, buffer.byteLength);

  /**
   * @param {number} start
   * @param {number} length
   */
  function parse(start, length) {
    const reader = readEBML(buffer, start, length);
    for (let el of reader) {
      if (el.tag in elementHandlers) {
        elementHandlers[el.tag](el);
      } else {
        chunks.push(
          el.tagBytes,
          el.sizeBytes,
          new DataView(buffer, el.start, el.length)
        );
      }
    }
  }

  return chunks;
}

/**
 * @param {Blob} blob
 */
async function readBlob(blob) {
  const reader = new FileReader();
  reader.readAsArrayBuffer(blob);

  await new Promise((resolve, reject) => {
    reader.onload = resolve;
    reader.onerror = e => reject(reader.error);
  });

  const result = reader.result;
  if (typeof result === "string") throw "unreachable";

  return result;
}

/* https://www.matroska.org/technical/specs/index.html */

/**
 * @param {ArrayBuffer} buffer
 * @param {number} start
 * @param {number} length
 */
function* readEBML(buffer, start, length) {
  const data = new DataView(buffer, start, length);
  const out = {};
  let cursor = 0;
  while (cursor < data.byteLength) {
    const idLength = readVintLength(data, cursor);
    const id = readVint(data, idLength, cursor);

    out.tag = schema.get(id);
    out.tagBytes = new DataView(buffer, start + cursor, idLength);
    if (!out.tag) {
      // debugger;
      throw new Error(`unknown element: ${id}`);
    }
    cursor += idLength;

    const sizeLength = readVintLength(data, cursor);
    const size = readVintValue(data, sizeLength, cursor);
    out.sizeBytes = new DataView(buffer, start + cursor, sizeLength);

    cursor += sizeLength;

    out.start = start + cursor;
    out.length = size < 0 ? undefined : size;

    yield out;

    if (size < 0) return;
    cursor += size;
  }
}

/**
 * @param {DataView} data
 * @param {number} start
 */
function readVintLength(data, start) {
  const lengthByte = data.getUint8(start);
  let length;
  for (length = 1; length <= 8; length++) {
    if (lengthByte & (1 << (8 - length))) break;
  }
  return length;
}
/**
 * @param {DataView} data
 * @param {number} length
 * @param {number} start
 */
function readVintValue(data, length, start) {
  let value = data.getUint8(start) & ((1 << (8 - length)) - 1);
  for (let i = 1; i < length; i++) {
    value *= 1 << 8;
    value += data.getUint8(start + i);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    // value greater than this is effectively unknown in js
    value = -1;
  }
  return value;
}
/**
 * @param {DataView} data
 * @param {number} length
 * @param {number} start
 */
function readVint(data, length, start) {
  let value = data.getUint8(start);
  for (let i = 1; i < length; i++) {
    value *= 1 << 8;
    value += data.getUint8(start + i);
  }
  return value;
}
/* https://github.com/node-ebml/node-ebml/blob/master/src/ebml/schema.js */
const schema = new Map([
  [0x80, "ChapterDisplay"],
  [0x83, "TrackType"],
  [0x85, "ChapString"],
  [0x86, "CodecID"],
  [0x88, "FlagDefault"],
  [0x89, "ChapterTrackNumber"],
  [0x91, "ChapterTimeStart"],
  [0x92, "ChapterTimeEnd"],
  [0x96, "CueRefTime"],
  [0x97, "CueRefCluster"],
  [0x98, "ChapterFlagHidden"],
  [0x4254, "ContentCompAlgo"],
  [0x4255, "ContentCompSettings"],
  [0x4282, "DocType"],
  [0x4285, "DocTypeReadVersion"],
  [0x4286, "EBMLVersion"],
  [0x4287, "DocTypeVersion"],
  [0x4444, "SegmentFamily"],
  [0x4461, "DateUTC"],
  [0x4484, "TagDefault"],
  [0x4485, "TagBinary"],
  [0x4487, "TagString"],
  [0x4489, "Duration"],
  [0x4598, "ChapterFlagEnabled"],
  [0x4660, "FileMimeType"],
  [0x4661, "FileUsedStartTime"],
  [0x4662, "FileUsedEndTime"],
  [0x4675, "FileReferral"],
  [0x5031, "ContentEncodingOrder"],
  [0x5032, "ContentEncodingScope"],
  [0x5033, "ContentEncodingType"],
  [0x5034, "ContentCompression"],
  [0x5035, "ContentEncryption"],
  [0x5378, "CueBlockNumber"],
  [0x5654, "ChapterStringUID"],
  [0x5741, "WritingApp"],
  [0x5854, "SilentTracks"],
  [0x6240, "ContentEncoding"],
  [0x6264, "BitDepth"],
  [0x6532, "SignedElement"],
  [0x6624, "TrackTranslate"],
  [0x6911, "ChapProcessCommand"],
  [0x6922, "ChapProcessTime"],
  [0x6924, "ChapterTranslate"],
  [0x6933, "ChapProcessData"],
  [0x6944, "ChapProcess"],
  [0x6955, "ChapProcessCodecID"],
  [0x7373, "Tag"],
  [0x7384, "SegmentFilename"],
  [0x7446, "AttachmentLink"],
  [0x258688, "CodecName"],
  [0x18538067, "Segment"],
  [0x447a, "TagLanguage"],
  [0x45a3, "TagName"],
  [0x67c8, "SimpleTag"],
  [0x63c6, "TagAttachmentUID"],
  [0x63c4, "TagChapterUID"],
  [0x63c9, "TagEditionUID"],
  [0x63c5, "TagTrackUID"],
  [0x63ca, "TargetType"],
  [0x68ca, "TargetTypeValue"],
  [0x63c0, "Targets"],
  [0x1254c367, "Tags"],
  [0x450d, "ChapProcessPrivate"],
  [0x437e, "ChapCountry"],
  [0x437c, "ChapLanguage"],
  [0x8f, "ChapterTrack"],
  [0x63c3, "ChapterPhysicalEquiv"],
  [0x6ebc, "ChapterSegmentEditionUID"],
  [0x6e67, "ChapterSegmentUID"],
  [0x73c4, "ChapterUID"],
  [0xb6, "ChapterAtom"],
  [0x45dd, "EditionFlagOrdered"],
  [0x45db, "EditionFlagDefault"],
  [0x45bd, "EditionFlagHidden"],
  [0x45bc, "EditionUID"],
  [0x45b9, "EditionEntry"],
  [0x1043a770, "Chapters"],
  [0x46ae, "FileUID"],
  [0x465c, "FileData"],
  [0x466e, "FileName"],
  [0x467e, "FileDescription"],
  [0x61a7, "AttachedFile"],
  [0x1941a469, "Attachments"],
  [0xeb, "CueRefCodecState"],
  [0x535f, "CueRefNumber"],
  [0xdb, "CueReference"],
  [0xea, "CueCodecState"],
  [0xb2, "CueDuration"],
  [0xf0, "CueRelativePosition"],
  [0xf1, "CueClusterPosition"],
  [0xf7, "CueTrack"],
  [0xb7, "CueTrackPositions"],
  [0xb3, "CueTime"],
  [0xbb, "CuePoint"],
  [0x1c53bb6b, "Cues"],
  [0x47e6, "ContentSigHashAlgo"],
  [0x47e5, "ContentSigAlgo"],
  [0x47e4, "ContentSigKeyID"],
  [0x47e3, "ContentSignature"],
  [0x47e2, "ContentEncKeyID"],
  [0x47e1, "ContentEncAlgo"],
  [0x6d80, "ContentEncodings"],
  [0xc4, "TrickMasterTrackSegmentUID"],
  [0xc7, "TrickMasterTrackUID"],
  [0xc6, "TrickTrackFlag"],
  [0xc1, "TrickTrackSegmentUID"],
  [0xc0, "TrickTrackUID"],
  [0xed, "TrackJoinUID"],
  [0xe9, "TrackJoinBlocks"],
  [0xe6, "TrackPlaneType"],
  [0xe5, "TrackPlaneUID"],
  [0xe4, "TrackPlane"],
  [0xe3, "TrackCombinePlanes"],
  [0xe2, "TrackOperation"],
  [0x7d7b, "ChannelPositions"],
  [0x9f, "Channels"],
  [0x78b5, "OutputSamplingFrequency"],
  [0xb5, "SamplingFrequency"],
  [0xe1, "Audio"],
  [0x2383e3, "FrameRate"],
  [0x2fb523, "GammaValue"],
  [0x2eb524, "ColourSpace"],
  [0x54b3, "AspectRatioType"],
  [0x54b2, "DisplayUnit"],
  [0x54ba, "DisplayHeight"],
  [0x54b0, "DisplayWidth"],
  [0x54dd, "PixelCropRight"],
  [0x54cc, "PixelCropLeft"],
  [0x54bb, "PixelCropTop"],
  [0x54aa, "PixelCropBottom"],
  [0xba, "PixelHeight"],
  [0xb0, "PixelWidth"],
  [0x53b9, "OldStereoMode"],
  [0x53c0, "AlphaMode"],
  [0x53b8, "StereoMode"],
  [0x9a, "FlagInterlaced"],
  [0xe0, "Video"],
  [0x66a5, "TrackTranslateTrackID"],
  [0x66bf, "TrackTranslateCodec"],
  [0x66fc, "TrackTranslateEditionUID"],
  [0x56bb, "SeekPreRoll"],
  [0x56aa, "CodecDelay"],
  [0x6fab, "TrackOverlay"],
  [0xaa, "CodecDecodeAll"],
  [0x26b240, "CodecDownloadURL"],
  [0x3b4040, "CodecInfoURL"],
  [0x3a9697, "CodecSettings"],
  [0x63a2, "CodecPrivate"],
  [0x22b59c, "Language"],
  [0x536e, "Name"],
  [0x55ee, "MaxBlockAdditionID"],
  [0x537f, "TrackOffset"],
  [0x23314f, "TrackTimecodeScale"],
  [0x234e7a, "DefaultDecodedFieldDuration"],
  [0x23e383, "DefaultDuration"],
  [0x6df8, "MaxCache"],
  [0x6de7, "MinCache"],
  [0x9c, "FlagLacing"],
  [0x55aa, "FlagForced"],
  [0xb9, "FlagEnabled"],
  [0x73c5, "TrackUID"],
  [0xd7, "TrackNumber"],
  [0xae, "TrackEntry"],
  [0x1654ae6b, "Tracks"],
  [0xaf, "EncryptedBlock"],
  [0xca, "ReferenceTimeCode"],
  [0xc9, "ReferenceOffset"],
  [0xc8, "ReferenceFrame"],
  [0xcf, "SliceDuration"],
  [0xce, "Delay"],
  [0xcb, "BlockAdditionID"],
  [0xcd, "FrameNumber"],
  [0xcc, "LaceNumber"],
  [0xe8, "TimeSlice"],
  [0x8e, "Slices"],
  [0x75a2, "DiscardPadding"],
  [0xa4, "CodecState"],
  [0xfd, "ReferenceVirtual"],
  [0xfb, "ReferenceBlock"],
  [0xfa, "ReferencePriority"],
  [0x9b, "BlockDuration"],
  [0xa5, "BlockAdditional"],
  [0xee, "BlockAddID"],
  [0xa6, "BlockMore"],
  [0x75a1, "BlockAdditions"],
  [0xa2, "BlockVirtual"],
  [0xa1, "Block"],
  [0xa0, "BlockGroup"],
  [0xa3, "SimpleBlock"],
  [0xab, "PrevSize"],
  [0xa7, "Position"],
  [0x58d7, "SilentTrackNumber"],
  [0xe7, "Timecode"],
  [0x1f43b675, "Cluster"],
  [0x4d80, "MuxingApp"],
  [0x7ba9, "Title"],
  [0x2ad7b2, "TimecodeScaleDenominator"],
  [0x2ad7b1, "TimecodeScale"],
  [0x69a5, "ChapterTranslateID"],
  [0x69bf, "ChapterTranslateCodec"],
  [0x69fc, "ChapterTranslateEditionUID"],
  [0x3e83bb, "NextFilename"],
  [0x3eb923, "NextUID"],
  [0x3c83ab, "PrevFilename"],
  [0x3cb923, "PrevUID"],
  [0x73a4, "SegmentUID"],
  [0x1549a966, "Info"],
  [0x53ac, "SeekPosition"],
  [0x53ab, "SeekID"],
  [0x4dbb, "Seek"],
  [0x114d9b74, "SeekHead"],
  [0x7e7b, "SignatureElementList"],
  [0x7e5b, "SignatureElements"],
  [0x7eb5, "Signature"],
  [0x7ea5, "SignaturePublicKey"],
  [0x7e9a, "SignatureHash"],
  [0x7e8a, "SignatureAlgo"],
  [0x1b538667, "SignatureSlot"],
  [0xbf, "CRC-32"],
  [0xec, "Void"],
  [0x42f3, "EBMLMaxSizeLength"],
  [0x42f2, "EBMLMaxIDLength"],
  [0x42f7, "EBMLReadVersion"],
  [0x1a45dfa3, "EBML"]
]);
