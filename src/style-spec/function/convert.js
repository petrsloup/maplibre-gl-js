const assert = require('assert');
const extend = require('../util/extend');

module.exports = convertFunction;

function convertFunction(parameters, propertySpec, name) {
    let expression;

    parameters = extend({}, parameters);
    let defaultExpression;
    if (typeof parameters.default !== 'undefined') {
        defaultExpression = convertValue(parameters.default, propertySpec);
    } else {
        defaultExpression = convertValue(propertySpec.default, propertySpec);
        if (defaultExpression === null) {
            defaultExpression = ['error', 'No default property value available.'];
        }
    }

    if (parameters.stops) {
        const zoomAndFeatureDependent = parameters.stops && typeof parameters.stops[0][0] === 'object';
        const featureDependent = zoomAndFeatureDependent || parameters.property !== undefined;
        const zoomDependent = zoomAndFeatureDependent || !featureDependent;

        const stops = parameters.stops.map((stop) => {
            return [stop[0], convertValue(stop[1], propertySpec)];
        });

        if (parameters.colorSpace && parameters.colorSpace !== 'rgb') {
            throw new Error('Unimplemented');
        }

        if (name === 'heatmap-color') {
            assert(zoomDependent);
            expression = convertZoomFunction(parameters, propertySpec, stops, ['heatmap-density']);
        } else if (zoomAndFeatureDependent) {
            expression = convertZoomAndPropertyFunction(parameters, propertySpec, stops, defaultExpression);
        } else if (zoomDependent) {
            expression = convertZoomFunction(parameters, propertySpec, stops);
        } else {
            expression = convertPropertyFunction(parameters, propertySpec, stops, defaultExpression);
        }
    } else {
        // identity function
        expression = convertIdentityFunction(parameters, propertySpec, defaultExpression);
    }

    return expression;
}

function convertIdentityFunction(parameters, propertySpec, defaultExpression) {
    const get = ['get', parameters.property];
    const type = propertySpec.type;
    if (type === 'color') {
        return ['to-color', get, parameters.default || null, propertySpec.default || null];
    } else if (type === 'array' && typeof propertySpec.length === 'number') {
        return ['array', propertySpec.value, propertySpec.length, get];
    } else if (type === 'array') {
        return ['array', propertySpec.value, get];
    } else if (type === 'enum') {
        return [
            'let',
            'property_value', ['string', get],
            [
                'match',
                ['var', 'property_value'],
                Object.keys(propertySpec.values), ['var', 'property_value'],
                defaultExpression
            ]
        ];
    } else {
        return [propertySpec.type, get, parameters.default || null, propertySpec.default || null];
    }
}

function convertValue(value, spec) {
    if (typeof value === 'undefined' || value === null) return null;
    if (spec.type === 'color') {
        return value;
    } else if (spec.type === 'array') {
        return ['literal', value];
    } else {
        return value;
    }
}

function convertZoomAndPropertyFunction(parameters, propertySpec, stops, defaultExpression) {
    const featureFunctionParameters = {};
    const featureFunctionStops = {};
    const zoomStops = [];
    for (let s = 0; s < stops.length; s++) {
        const stop = stops[s];
        const zoom = stop[0].zoom;
        if (featureFunctionParameters[zoom] === undefined) {
            featureFunctionParameters[zoom] = {
                zoom: zoom,
                type: parameters.type,
                property: parameters.property,
                default: parameters.default,
            };
            featureFunctionStops[zoom] = [];
            zoomStops.push(zoom);
        }
        featureFunctionStops[zoom].push([stop[0].value, stop[1]]);
    }

    // the interpolation type for the zoom dimension of a zoom-and-property
    // function is determined directly from the style property specification
    // for which it's being used: linear for interpolatable properties, step
    // otherwise.
    const functionType = getFunctionType({}, propertySpec);
    let interpolationType;
    let isStep = false;
    if (functionType === 'exponential') {
        interpolationType = ['linear'];
    } else {
        interpolationType = ['step'];
        isStep = true;
    }
    const expression = ['curve', interpolationType, ['zoom']];

    for (const z of zoomStops) {
        const output = convertPropertyFunction(featureFunctionParameters[z], propertySpec, featureFunctionStops[z], defaultExpression);
        appendStopPair(expression, z, output, isStep);
    }

    fixupDegenerateStepCurve(expression);

    return expression;
}

function convertPropertyFunction(parameters, propertySpec, stops, defaultExpression) {
    const type = getFunctionType(parameters, propertySpec);

    const inputType = typeof stops[0][0];
    assert(
        inputType === 'string' ||
        inputType === 'number' ||
        inputType === 'boolean'
    );

    let input = [inputType, ['get', parameters.property]];

    let expression;
    let isStep = false;
    if (type === 'categorical' && inputType === 'boolean') {
        assert(parameters.stops.length > 0 && parameters.stops.length <= 2);
        if (parameters.stops[0][0] === false) {
            input = ['!', input];
        }
        expression = [ 'case', input, parameters.stops[0][1] ];
        if (parameters.stops.length > 1) {
            expression.push(parameters.stops[1][1]);
        } else {
            expression.push(defaultExpression);
        }
        return expression;
    } else if (type === 'categorical') {
        expression = ['match', input];
    } else if (type === 'interval') {
        expression = ['curve', ['step'], input];
        isStep = true;
    } else if (type === 'exponential') {
        const base = parameters.base !== undefined ? parameters.base : 1;
        expression = ['curve', ['exponential', base], input];
    } else {
        throw new Error(`Unknown property function type ${type}`);
    }

    for (const stop of stops) {
        appendStopPair(expression, stop[0], stop[1], isStep);
    }

    if (expression[0] === 'match') {
        expression.push(defaultExpression);
    }

    fixupDegenerateStepCurve(expression);

    return expression;
}

function convertZoomFunction(parameters, propertySpec, stops, input = ['zoom']) {
    const type = getFunctionType(parameters, propertySpec);
    let expression;
    let isStep = false;
    if (type === 'interval') {
        expression = ['curve', ['step'], input];
        isStep = true;
    } else if (type === 'exponential') {
        const base = parameters.base !== undefined ? parameters.base : 1;
        expression = ['curve', ['exponential', base], input];
    } else {
        throw new Error(`Unknown zoom function type "${type}"`);
    }

    for (const stop of stops) {
        appendStopPair(expression, stop[0], stop[1], isStep);
    }

    fixupDegenerateStepCurve(expression);

    return expression;
}

function fixupDegenerateStepCurve(expression) {
    // degenerate step curve (i.e. a constant function): add a noop stop
    if (expression[0] === 'curve' && expression[1][0] === 'step' && expression.length === 4) {
        expression.push(0);
        expression.push(expression[3]);
    }
}

function appendStopPair(curve, input, output, isStep) {
    // step curves don't get the first input value, as it is redundant.
    if (!(isStep && curve.length === 3)) {
        curve.push(input);
    }
    curve.push(output);
}

function getFunctionType (parameters, propertySpec) {
    if (parameters.type) {
        return parameters.type;
    } else if (propertySpec.function) {
        return propertySpec.function === 'interpolated' ? 'exponential' : 'interval';
    } else {
        return 'exponential';
    }
}