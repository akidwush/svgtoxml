import { convertSvgToAlightXml as convertSvgToAlightXmlCore } from './converter-core.js';
import {
  getFilledPathGeometryScopeStats,
  withFilledPathGeometryScope
} from './path-geometry.js';

const SMART_COLOR_GROUP_MAX_WORK_UNITS = 20_000_000;

export function convertSvgToAlightXml(svgInput, rawOptions = {}) {
  return withFilledPathGeometryScope(() => {
    const result = convertSvgToAlightXmlCore(svgInput, rawOptions);
    if (result?.profile?.quality === 'color-group' && result.grouping) {
      const geometry = getFilledPathGeometryScopeStats();
      if (geometry) {
        result.grouping.preparedGeometries = geometry.preparedGeometries;
        result.grouping.geometryCacheHits = geometry.geometryCacheHits;
        result.grouping.samplePreparations = geometry.samplePreparations;
        result.grouping.segmentBoundsTests = geometry.segmentBoundsTests;
        result.grouping.segmentBoundsRejected = geometry.segmentBoundsRejected;
        result.grouping.segmentComparisons = geometry.segmentComparisons;
        result.grouping.paintPointTests = geometry.paintPointTests;
        result.grouping.geometryWorkUnits = geometry.workUnits;
        result.grouping.geometryWorkLimit = geometry.maxWorkUnits;
      }
    }
    return result;
  }, { maxWorkUnits: SMART_COLOR_GROUP_MAX_WORK_UNITS });
}
