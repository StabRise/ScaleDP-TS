/**
 * Names of the sessions PaddleOCR stages share, for `Stage.resources`.
 *
 * `paddle-service` caches sessions per preset at module level, so every stage
 * on the full service shares one pair of sessions and every recognizer-only
 * stage shares another. An ONNX session runs one inference at a time; claiming
 * these names is how the scheduler keeps two such stages from entering one
 * session together when several pages are in flight.
 */

/** The full detect-then-read service's sessions. */
export const PADDLE_SERVICE_RESOURCE = 'ort:paddle'

/** The recognition-only sessions. */
export const PADDLE_RECOGNIZER_RESOURCE = 'ort:paddle-rec'
