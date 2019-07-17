import {Subsystem, Type, MaxDataSize} from '../unpi/constants';
import {Frame as UnpiFrame} from '../unpi';
import Definition from './definition';
import Parsers from '../types/parsers';
import {Type as ParameterType, TsType as TypeTsTypes} from '../types';
import {MtParameter, MtCmd, ZpiObjectPayload, MtType} from './tstype';

const BufferAndListTypes = [
    ParameterType.BUFFER, ParameterType.BUFFER8, ParameterType.BUFFER16,
    ParameterType.BUFFER18, ParameterType.BUFFER32, ParameterType.BUFFER42,
    ParameterType.BUFFER100, ParameterType.LIST_UINT16, ParameterType.LIST_ROUTING_TABLE,
    ParameterType.LIST_BIND_TABLE, ParameterType.LIST_NEIGHBOR_LQI, ParameterType.LIST_NETWORK,
    ParameterType.LIST_ASSOC_DEV,
];

class ZpiObject {
    public readonly subsystem: Subsystem;
    public readonly command: string;
    public readonly commandID: number;
    public readonly payload: ZpiObjectPayload;
    public readonly type: Type;

    private readonly parameters: MtParameter[];

    private constructor(
        type: Type, subsystem: Subsystem, command: string, commandID: number, payload: ZpiObjectPayload,
        parameters: MtParameter[],
    ) {
        this.subsystem = subsystem;
        this.command = command;
        this.commandID = commandID;
        this.payload = payload;
        this.type = type;
        this.parameters = parameters;
    }

    public static createRequest(subsystem: Subsystem, command: string, payload: ZpiObjectPayload): ZpiObject {
        const cmd = Definition[subsystem].find((c: MtCmd): boolean => c.name === command);

        if (!cmd) {
            throw new Error(`Command '${command}' from subsystem '${subsystem}' not found`);
        }

        if (cmd.request === undefined) {
            throw new Error(`Command '${command}' from subsystem '${subsystem}' cannot be a request`);
        }

        return new ZpiObject(cmd.type, subsystem, command, cmd.ID, payload, cmd.request);
    }

    public toUnpiFrame(): UnpiFrame {
        const buffer = this.createPayloadBuffer();
        return new UnpiFrame(this.type, this.subsystem, this.commandID, buffer);
    }

    public static fromUnpiFrame(frame: UnpiFrame): ZpiObject {
        const cmd = Definition[frame.subsystem].find((c: MtCmd): boolean => c.ID === frame.commandID);

        if (!cmd) {
            throw new Error(`CommandID '${frame.commandID}' from subsystem '${frame.subsystem}' not found`);
        }

        const parameters = frame.type === Type.SRSP ? cmd.response : cmd.request;

        if (parameters === undefined) {
            throw new Error(
                `CommandID '${frame.commandID}' from subsystem '${frame.subsystem}' cannot be a ` +
                `${frame.type === Type.SRSP ? 'response' : 'request'}`
            );
        }

        const payload = this.readParameters(frame.data, parameters);
        return new ZpiObject(frame.type, frame.subsystem, cmd.name, cmd.ID, payload, parameters);
    }

    private static readParameters(buffer: Buffer, parameters: MtParameter[]): ZpiObjectPayload {
        let offset = 0;
        let result: ZpiObjectPayload = {};

        for (let parameter of parameters) {
            const parser = Parsers[parameter.parameterType];
            const options: TypeTsTypes.ParserOptions = {};

            if (parser === undefined) {
                throw new Error(`Missing read parser for ${ParameterType[parameter.parameterType]} - ${parameter.name}`);
            }

            if (BufferAndListTypes.includes(parameter.parameterType)) {
                // When reading a buffer, assume that the previous parsed parameter contains
                // the length of the buffer
                const lengthParameter = parameters[parameters.indexOf(parameter) - 1];
                const length: MtType = result[lengthParameter.name];
                if (typeof length === 'number') {
                    options.length = length;
                }

                if (parameter.parameterType === ParameterType.LIST_ASSOC_DEV) {
                    // For LIST_ASSOC_DEV, we also need to grab the startindex which is right before the length
                    const startIndexParameter = parameters[parameters.indexOf(parameter) - 2];
                    const startIndex: MtType = result[startIndexParameter.name];
                    if (typeof startIndex === 'number') {
                        options.startIndex = startIndex;
                    }
                }
            }

            const parsed = parser.read(buffer, offset, options);
            result[parameter.name] = parsed.value

            offset += parsed.length;
        }

        return result;
    }

    private createPayloadBuffer(): Buffer {
        const buffer = Buffer.alloc(MaxDataSize);
        let offset = 0;

        for (let parameter of this.parameters) {
            const parser = Parsers[parameter.parameterType];

            if (parser === undefined) {
                throw new Error(`Missing write parser for ${ParameterType[parameter.parameterType]} - ${this.command}`);
            }

            const value = this.payload[parameter.name];
            const length = parser.write(buffer, offset, value);
            offset += length;
        }

        return buffer.slice(0, offset);
    }

    public isResetCommand(): boolean {
        return (this.command === 'resetReq' && this.subsystem === Subsystem.SYS) ||
            (this.command === 'systemReset' && this.subsystem === Subsystem.SAPI);
    }
}

export default ZpiObject;